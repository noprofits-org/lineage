export async function stubD3(page) {
  // Serve the exact bytes of the pinned CDN file so the SRI integrity
  // attribute on the script tag still validates against the stub.
  await page.route('https://cdn.jsdelivr.net/npm/d3@7.9.0/**', route =>
    route.fulfill({ path: 'tests/fixtures/d3.v7.min.js', contentType: 'text/javascript' }))
}

// overrides: {pathSuffix: responseObjectOrFn} matched against url.pathname
export async function stubApi(page, fixtures, overrides = {}) {
  await stubD3(page)
  await page.route('https://api.semanticscholar.org/**', async route => {
    const url = new URL(route.request().url())
    const p = url.pathname
    for (const [suffix, resp] of Object.entries(overrides)) {
      if (p.endsWith(suffix)) {
        const r = typeof resp === 'function' ? await resp(url) : resp
        if (r.abort) return route.abort(r.abort)
        return route.fulfill({ status: r.status ?? 200, headers: r.headers ?? {}, json: r.json ?? r })
      }
    }
    if (p.endsWith('/paper/search')) return route.fulfill({ json: fixtures.routes.search })
    if (p.endsWith('/references')) return route.fulfill({ json: fixtures.routes.references })
    if (p.endsWith('/citations')) return route.fulfill({ json: fixtures.routes.citations })
    if (/\/paper\/[^/]+$/.test(p)) return route.fulfill({ json: fixtures.routes.paper })
    return route.fulfill({ status: 404, json: { error: 'not stubbed: ' + p } })
  })
}
