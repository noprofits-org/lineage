export async function stubD3(page) {
  // Serve the exact bytes of the pinned CDN file so the SRI attribute on the
  // script tag still validates against the stub.
  await page.route('https://cdn.jsdelivr.net/npm/d3@7.9.0/**', route =>
    route.fulfill({ path: 'tests/fixtures/d3.v7.min.js', contentType: 'text/javascript' }))
}

// Provider-scoped overrides avoid collisions between similarly named Index
// and Meta operations. Each value may be a response object or async function.
// Example: { crossref: { search }, index: { citations }, meta: { metadata } }.
export async function stubApi(page, fixtures, overrides = {}) {
  await stubD3(page)

  await page.route('https://api.crossref.org/**', async route => {
    const url = new URL(route.request().url())
    const path = url.pathname.replace(/^\/v1/, '')
    if (path === '/works' || path === '/works/') {
      return fulfill(route, await resolve(overrides.crossref?.search, url, fixtures.routes.search))
    }
    if (path.startsWith('/works/')) {
      const doi = decodeURIComponent(path.slice('/works/'.length)).toLowerCase()
      const fallback = fixtures.routes.details.get(doi)
      if (fallback === undefined && overrides.crossref?.detail === undefined) {
        return fulfill(route, { status: 404, json: {} })
      }
      return fulfill(route, await resolve(overrides.crossref?.detail, url, fallback, { doi }))
    }
    return fulfill(route, { status: 404, json: { error: `unstubbed Crossref path: ${path}` } })
  })

  await page.route('https://api.opencitations.net/index/v2/**', async route => {
    const url = new URL(route.request().url())
    const match = url.pathname.match(/\/(citation-count|reference-count|citations|references)\/(.+)$/)
    if (!match) {
      return fulfill(route, { status: 404, json: { error: `unstubbed Index path: ${url.pathname}` } })
    }
    const operation = {
      'citation-count': 'citationCount',
      'reference-count': 'referenceCount',
      citations: 'citations',
      references: 'references',
    }[match[1]]
    const fallback = fixtures.routes[operation]
    return fulfill(route, await resolve(
      overrides.index?.[operation],
      url,
      fallback,
      { id: decodeURIComponent(match[2]) },
    ))
  })

  await page.route('https://api.opencitations.net/meta/v1/**', async route => {
    const url = new URL(route.request().url())
    const match = url.pathname.match(/\/metadata\/(.+)$/)
    if (!match) {
      return fulfill(route, { status: 404, json: { error: `unstubbed Meta path: ${url.pathname}` } })
    }
    const ids = match[1].split('__').map(decodeURIComponent)
    const fallback = ids.map(id => fixtures.routes.meta.get(id)).filter(Boolean)
    return fulfill(route, await resolve(
      overrides.meta?.metadata,
      url,
      fallback,
      { ids },
    ))
  })
}

async function resolve(override, url, fallback, context) {
  if (override === undefined) return { json: fallback }
  if (typeof override === 'function') return override(url, context, fallback)
  return override
}

function fulfill(route, response) {
  const value = response || {}
  if (value.abort) return route.abort(value.abort)
  return route.fulfill({
    status: value.status ?? 200,
    headers: value.headers ?? {},
    json: value.json ?? value,
  })
}
