import { test, expect } from '@playwright/test'
import * as fixtures from './fixtures.mjs'
import { stubApi } from './helpers.mjs'

test('404 surfaces immediately with no retry button', async ({ page }) => {
  await stubApi(page, fixtures, {
    crossref: { search: { status: 404, json: {} } },
  })
  await page.goto('/')
  await page.fill('#search', 'nucleic')
  await page.press('#search', 'Enter')
  await expect(page.locator('#status')).toContainText('paper not found')
  await expect(page.locator('#retry')).toBeHidden()
})

test('a non-retryable expansion error does not promise an unavailable retry', async ({ page }) => {
  await stubApi(page, fixtures, {
    index: { references: { status: 404, json: {} } },
  })
  await page.goto('/')
  await page.fill('#search', 'nucleic')
  await page.press('#search', 'Enter')
  await page.locator('#results li').first().click()
  await page.getByTestId('expand-references').click()

  await expect(page.getByTestId('references-status')).toHaveText('references request failed')
  await expect(page.locator('#retry')).toBeHidden()
})

test('429 with Retry-After reports backoff, then succeeds', async ({ page }) => {
  let calls = 0
  await stubApi(page, fixtures, {
    crossref: { search: () => {
      calls++
      return calls === 1
        ? { status: 429, headers: { 'Retry-After': '1' }, json: {} }
        : { json: fixtures.routes.search }
    } },
  })
  await page.goto('/')
  await page.fill('#search', 'nucleic')
  await page.press('#search', 'Enter')
  await expect(page.locator('#status')).toContainText('rate limited — retrying in 1s')
  await expect(page.locator('#results li').first()).toBeVisible({ timeout: 10_000 })
})

test('retry exhaustion exposes a manual retry that works after recovery', async ({ page }) => {
  let healthy = false
  await stubApi(page, fixtures, {
    index: {
      citations: () => (
        healthy ? { json: fixtures.routes.citations } : { status: 503, json: {} }
      ),
    },
  })
  await page.goto('/')
  await page.fill('#search', 'nucleic')
  await page.press('#search', 'Enter')
  await page.locator('#results li').first().click()
  await page.getByTestId('expand-citations').click()
  await expect(page.locator('#retry')).toBeVisible({ timeout: 60_000 })
  healthy = true
  await page.locator('#retry').click()
  await expect(page.locator('.node')).toHaveCount(26, { timeout: 15_000 })
})

test('a successful direction does not steal another direction\'s manual retry', async ({ page }) => {
  test.setTimeout(60_000)
  let referencesHealthy = false
  await stubApi(page, fixtures, {
    index: {
      references: () => (
        referencesHealthy
          ? { json: fixtures.routes.references }
          : { status: 503, json: {} }
      ),
    },
  })
  await page.goto('/')
  await page.fill('#search', 'nucleic')
  await page.press('#search', 'Enter')
  await page.locator('#results li').first().click()
  await expect(page.getByTestId('insp-abstract')).toContainText('deoxyribose')

  await page.getByTestId('expand-references').click()
  await page.getByTestId('expand-citations').click()
  await expect(page.locator('.node')).toHaveCount(26, { timeout: 30_000 })
  await expect(page.locator('#retry')).toBeVisible()
  await expect(page.getByTestId('references-status')).toContainText('retry available')

  referencesHealthy = true
  await page.locator('#retry').click()
  await expect(page.locator(fixtures.idSelector(fixtures.REFS[0]))).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('.node')).toHaveCount(29)
  await expect(page.locator('#retry')).toBeHidden()
})

test('paper-detail retry exhaustion offers a manual retry for the missing abstract', async ({ page }) => {
  test.setTimeout(60_000)
  let paperHealthy = false
  await stubApi(page, fixtures, {
    crossref: {
      detail: (url, { doi }, fallback) => {
        if (doi !== fixtures.SEED.doi) return { json: fallback }
        return paperHealthy
          ? { json: fixtures.crossrefDetail(fixtures.SEED, {
              abstract: 'A structure for deoxyribose nucleic acid.',
            }) }
          : { status: 503, json: {} }
      },
    },
  })
  await page.goto('/')
  await page.fill('#search', 'nucleic')
  await page.press('#search', 'Enter')
  await page.locator('#results li').first().click()

  await expect(page.locator('#retry')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('insp-abstract')).toBeHidden()
  paperHealthy = true
  await page.locator('#retry').click()

  await expect(page.getByTestId('insp-abstract')).toContainText(
    'deoxyribose',
    { timeout: 15_000 },
  )
  await expect(page.locator('#retry')).toBeHidden()
})

test('an offline request recovers automatically when connectivity returns', async ({ page }) => {
  let calls = 0
  await stubApi(page, fixtures, {
    index: {
      citations: () => {
        calls += 1
        return calls === 1
          ? { abort: 'internetdisconnected' }
          : { json: fixtures.routes.citations }
      },
    },
  })
  await page.goto('/')
  await page.fill('#search', 'nucleic')
  await page.press('#search', 'Enter')
  await page.locator('#results li').first().click()
  await expect(page.getByTestId('insp-abstract')).toContainText('deoxyribose')

  await page.getByTestId('expand-citations').click()
  await expect(page.locator('.node')).toHaveCount(26, { timeout: 15_000 })
  expect(calls).toBe(2)
})

test('narrow viewport uses a bottom-sheet inspector with a close button', async ({ page }) => {
  await stubApi(page, fixtures)
  await page.setViewportSize({ width: 480, height: 800 })
  await page.goto('/')
  await page.fill('#search', 'nucleic')
  await page.press('#search', 'Enter')
  await page.locator('#results li').first().click()
  const box = await page.locator('#inspector').boundingBox()
  expect(box.width).toBeGreaterThan(400)
  expect(box.y).toBeGreaterThan(300)
  await page.locator('#inspector-close').click()
  await expect(page.locator('#inspector')).toBeHidden()
})

test('an OMID-only connection is hydrated through OpenCitations Meta', async ({ page }) => {
  const omidOnly = fixtures.paper(
    'omid-only',
    1942,
    null,
    'Metadata Fallback Paper',
    null,
    { doi: null, omid: 'omid:br/069999' },
  )
  await stubApi(page, fixtures, {
    index: {
      references: {
        json: [fixtures.edge(fixtures.SEED, omidOnly, { oci: 'omid-edge' })],
      },
    },
    meta: {
      metadata: (url, { ids }) => {
        expect(ids).toEqual(['omid:br/069999'])
        return { json: [fixtures.metaRecord(omidOnly)] }
      },
    },
  })
  await page.goto('/')
  await page.fill('#search', 'nucleic')
  await page.press('#search', 'Enter')
  await page.locator('#results li').first().click()
  await page.getByTestId('expand-references').click()

  await expect(page.locator(fixtures.idSelector(omidOnly))).toBeVisible()
  await expect(page.getByTestId('references-status')).not.toContainText('top')
})

test('missing DOI metadata still admits the known edge as a minimal node', async ({ page }) => {
  const missing = fixtures.paper('missing-metadata', 1940, null, 'Unavailable upstream')
  await stubApi(page, fixtures, {
    index: {
      referenceCount: { json: [{ count: '1' }] },
      references: { json: [fixtures.edge(fixtures.SEED, missing)] },
    },
    crossref: {
      detail: (url, { doi }, fallback) => (
        doi === missing.doi ? { status: 404, json: {} } : { json: fallback }
      ),
    },
    meta: { metadata: { json: [] } },
  })
  await page.goto('/')
  await page.fill('#search', 'nucleic')
  await page.press('#search', 'Enter')
  await page.locator('#results li').first().click()
  await page.getByTestId('expand-references').click()

  await expect(page.locator(fixtures.idSelector(missing))).toBeVisible()
  await expect(page.locator('#status')).toContainText(/metadata incomplete|showing 1 of 1/i)
  await expect(page.getByTestId('rel-cites').locator('li')).toHaveCount(1)
})

test('retryable candidate metadata failure admits the edge and offers a focused retry', async ({ page }) => {
  test.setTimeout(60_000)
  const recovering = fixtures.paper('recovering-metadata', 1941, 12, 'Recovered metadata')
  let healthy = false
  await stubApi(page, fixtures, {
    index: {
      referenceCount: { json: [{ count: '1' }] },
      references: { json: [fixtures.edge(fixtures.SEED, recovering)] },
    },
    crossref: {
      detail: (url, { doi }, fallback) => {
        if (doi === fixtures.SEED.doi) return { json: fallback }
        return healthy
          ? { json: fixtures.crossrefDetail(recovering) }
          : { status: 503, headers: { 'Retry-After': '0' }, json: {} }
      },
    },
  })
  await page.goto('/')
  await page.fill('#search', 'nucleic')
  await page.press('#search', 'Enter')
  await page.locator('#results li').first().click()
  await page.getByTestId('expand-references').click()

  await expect(page.locator(fixtures.idSelector(recovering))).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('#status')).toContainText('metadata incomplete')
  await expect(page.locator('#retry')).toBeVisible()

  healthy = true
  await page.locator('#retry').click()
  await expect(page.locator('#retry')).toBeHidden({ timeout: 15_000 })
  await page.locator(fixtures.idSelector(recovering)).focus()
  await page.locator(fixtures.idSelector(recovering)).press('Enter')
  await expect(page.getByTestId('insp-title')).toHaveText('Recovered metadata')
  await expect(page.getByTestId('insp-meta')).not.toContainText('metadata incomplete')
})

test('load more preserves an earlier metadata-retry backlog', async ({ page }) => {
  test.setTimeout(60_000)
  let healthy = false
  let edgeCalls = 0
  await stubApi(page, fixtures, {
    index: {
      citations: () => {
        edgeCalls += 1
        return { json: fixtures.routes.citations }
      },
    },
    crossref: {
      detail: (url, { doi }, fallback) => {
        if (doi === fixtures.SEED.doi || healthy) return { json: fallback }
        return { status: 503, headers: { 'Retry-After': '0' }, json: {} }
      },
    },
  })
  await page.goto('/')
  await page.fill('#search', 'nucleic')
  await page.press('#search', 'Enter')
  await page.locator('#results li').first().click()
  await page.getByTestId('expand-citations').click()

  await expect(page.locator('.node')).toHaveCount(26, { timeout: 15_000 })
  await expect(page.locator('#retry')).toBeVisible()

  healthy = true
  await page.getByTestId('load-more').click()
  await expect(page.locator('.node')).toHaveCount(31, { timeout: 15_000 })
  expect(edgeCalls).toBe(1)
  await expect(page.locator('#retry')).toBeVisible()
  await expect(page.locator('#status')).toContainText('retry available')

  await page.locator('#retry').click()
  await expect(page.locator('#retry')).toBeHidden({ timeout: 20_000 })
  await page.locator(fixtures.idSelector(fixtures.CITS[0])).focus()
  await page.locator(fixtures.idSelector(fixtures.CITS[0])).press('Enter')
  await expect(page.getByTestId('insp-title')).toHaveText(fixtures.CITS[0].title)
  await expect(page.getByTestId('insp-meta')).not.toContainText('metadata incomplete')
})

test('PMID-only edges survive as minimal identifier nodes without forbidden hydration', async ({ page }) => {
  const pmidId = 'pmid:123456'
  let metadataCalls = 0
  await stubApi(page, fixtures, {
    index: {
      citationCount: { json: [{ count: '1' }] },
      citations: {
        json: [{
          citing: pmidId,
          cited: fixtures.pidBundle(fixtures.SEED),
          creation: '1978',
          timespan: 'P25Y',
        }],
      },
    },
    crossref: {
      detail: (url, { doi }, fallback) => {
        if (doi !== fixtures.SEED.doi) metadataCalls += 1
        return { json: fallback }
      },
    },
    meta: {
      metadata: () => {
        metadataCalls += 1
        return { json: [] }
      },
    },
  })
  await page.goto('/')
  await page.fill('#search', 'nucleic')
  await page.press('#search', 'Enter')
  await page.locator('#results li').first().click()
  await page.getByTestId('expand-citations').click()

  await expect(page.locator(`[data-id="${pmidId}"]`)).toBeVisible()
  expect(metadataCalls).toBe(0)
})
