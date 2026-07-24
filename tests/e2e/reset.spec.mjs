import { test, expect } from '@playwright/test'
import * as fixtures from './fixtures.mjs'
import { stubApi } from './helpers.mjs'

async function seed(page) {
  await page.fill('#search', 'nucleic')
  await page.press('#search', 'Enter')
  await page.locator('#results li').first().click()
}

test('reset clears the graph and restores the empty state', async ({ page }) => {
  await stubApi(page, fixtures)
  await page.goto('/')
  await seed(page)
  await page.locator('#reset').click()
  await expect(page.locator('.node')).toHaveCount(0)
  await expect(page.locator('#empty')).toBeVisible()
  await expect(page.locator('#inspector')).toBeHidden()
  await expect(page.locator('#search')).toBeFocused()
})

test('a response landing after reset is discarded', async ({ page }) => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  await stubApi(page, fixtures, {
    index: {
      citations: async () => { await gate; return { json: fixtures.routes.citations } },
    },
  })
  await page.goto('/')
  await seed(page)
  await page.getByTestId('expand-citations').click()
  await page.locator('#reset').click()
  release()
  await page.waitForTimeout(300)
  await expect(page.locator('.node')).toHaveCount(0)
})

test('a preflight count landing after reset cannot start an edge fetch', async ({ page }) => {
  let release
  let markStarted
  let edgeCalls = 0
  const gate = new Promise(resolve => { release = resolve })
  const started = new Promise(resolve => { markStarted = resolve })
  await stubApi(page, fixtures, {
    index: {
      citationCount: async () => {
        markStarted()
        await gate
        return { json: [{ count: '30' }] }
      },
      citations: () => {
        edgeCalls += 1
        return { json: fixtures.routes.citations }
      },
    },
  })
  await page.goto('/')
  await seed(page)
  await page.getByTestId('expand-citations').click()
  await started
  await page.locator('#reset').click()
  release()

  await page.waitForTimeout(300)
  expect(edgeCalls).toBe(0)
  await expect(page.locator('.node')).toHaveCount(0)
})

test('candidate metadata landing after reset cannot admit a node', async ({ page }) => {
  const oneCitation = fixtures.CITS[0]
  let release
  let markStarted
  const gate = new Promise(resolve => { release = resolve })
  const started = new Promise(resolve => { markStarted = resolve })
  await stubApi(page, fixtures, {
    index: {
      citationCount: { json: [{ count: '1' }] },
      citations: { json: [fixtures.edge(oneCitation, fixtures.SEED)] },
    },
    crossref: {
      detail: async (url, { doi }, fallback) => {
        if (doi === fixtures.SEED.doi) return { json: fallback }
        markStarted()
        await gate
        return { json: fallback }
      },
    },
  })
  await page.goto('/')
  await seed(page)
  await page.getByTestId('expand-citations').click()
  await started
  await page.locator('#reset').click()
  release()

  await page.waitForTimeout(300)
  await expect(page.locator('.node')).toHaveCount(0)
})

test('an alias merge cancels in-flight expansion work and leaves the survivor resumable', async ({ page }) => {
  test.setTimeout(30_000)
  const pageErrors = []
  page.on('pageerror', error => pageErrors.push(error.message))
  const canonical = fixtures.paper('alias-canonical', 1960, 10, 'Canonical paper')
  const omidOnly = fixtures.paper(
    'alias-duplicate',
    1961,
    null,
    'Temporary OMID paper',
    0,
    { doi: null, omid: 'omid:br/alias-duplicate' },
  )
  const bridge = {
    ...canonical,
    omid: omidOnly.paperId,
    aliases: [`doi:${canonical.doi}`, omidOnly.paperId],
  }
  let metaCalls = 0
  let releaseBridge
  let markBridgeStarted
  let citationCountCalls = 0
  const bridgeGate = new Promise(resolve => { releaseBridge = resolve })
  const bridgeStarted = new Promise(resolve => { markBridgeStarted = resolve })

  await stubApi(page, fixtures, {
    index: {
      referenceCount: { json: [{ count: '2' }] },
      references: {
        json: [
          fixtures.edge(fixtures.SEED, canonical),
          fixtures.edge(fixtures.SEED, omidOnly),
        ],
      },
      citationCount: () => {
        citationCountCalls += 1
        return { json: [{ count: '0' }] }
      },
    },
    crossref: {
      detail: (url, { doi }, fallback) => (
        doi === canonical.doi
          ? { json: fixtures.crossrefDetail(canonical) }
          : { json: fallback }
      ),
    },
    meta: {
      metadata: async () => {
        metaCalls += 1
        if (metaCalls <= 4) {
          return { status: 503, headers: { 'Retry-After': '0' }, json: {} }
        }
        markBridgeStarted()
        await bridgeGate
        return { json: [fixtures.metaRecord(bridge)] }
      },
    },
  })
  await page.goto('/')
  await seed(page)
  await page.getByTestId('expand-references').click()
  await expect(page.locator('.node')).toHaveCount(3, { timeout: 10_000 })

  await page.locator(fixtures.idSelector(omidOnly)).focus()
  await page.locator(fixtures.idSelector(omidOnly)).press('Enter')
  await bridgeStarted
  await page.getByTestId('expand-citations').click()
  releaseBridge()

  await page.waitForTimeout(500)
  expect(pageErrors).toEqual([])
  await expect(page.locator('.node')).toHaveCount(2, { timeout: 10_000 })
  await expect(page.locator(fixtures.idSelector(omidOnly))).toHaveCount(0)
  await expect(page.locator(fixtures.idSelector(canonical))).toBeVisible()
  await expect(page.getByTestId('expand-citations')).toBeEnabled()
  await page.waitForTimeout(500)
  expect(citationCountCalls).toBe(0)

  await page.getByTestId('expand-citations').click()
  await expect(page.getByTestId('citations-status')).toContainText('0 known open citations')
  expect(citationCountCalls).toBe(1)
})

test('reset drops candidate hydration queued behind selected-paper details', async ({ page }) => {
  let releasePaper
  let markPaperStarted
  let candidateDetailCalls = 0
  const paperGate = new Promise(resolve => { releasePaper = resolve })
  const paperStarted = new Promise(resolve => { markPaperStarted = resolve })
  await stubApi(page, fixtures, {
    crossref: {
      detail: async (url, { doi }, fallback) => {
        if (doi !== fixtures.SEED.doi) {
          candidateDetailCalls += 1
          return { json: fallback }
        }
        markPaperStarted()
        await paperGate
        return { json: fixtures.crossrefDetail(fixtures.SEED, {
          abstract: 'A structure for deoxyribose nucleic acid.',
        }) }
      },
    },
  })
  await page.goto('/')
  await seed(page)
  await paperStarted
  const edgeResponse = page.waitForResponse(response =>
    response.url().includes('/index/v2/citations/'))
  await page.getByTestId('expand-citations').click()
  await edgeResponse
  await expect(page.getByTestId('citations-status')).toContainText('loading citations paper details')
  await page.locator('#reset').click()
  releasePaper()

  await page.waitForTimeout(500)
  expect(candidateDetailCalls).toBe(0)
  await expect(page.locator('.node')).toHaveCount(0)
  await expect(page.locator('#status')).toHaveText('ready')
})

test('closing details during expansion does not let completion reopen them', async ({ page }) => {
  let release
  let markStarted
  const gate = new Promise(resolve => { release = resolve })
  const started = new Promise(resolve => { markStarted = resolve })
  await stubApi(page, fixtures, {
    index: {
      citations: async () => {
        markStarted()
        await gate
        return { json: fixtures.routes.citations }
      },
    },
  })
  await page.goto('/')
  await seed(page)
  await expect(page.getByTestId('insp-abstract')).toContainText('deoxyribose')
  await page.getByTestId('expand-citations').click()
  await started
  await page.locator('#inspector-close').click()
  release()

  await expect(page.locator('.node')).toHaveCount(26, { timeout: 10_000 })
  await expect(page.locator('#inspector')).toBeHidden()
})

test('choosing a new seed replaces the existing graph', async ({ page }) => {
  await stubApi(page, fixtures)
  await page.goto('/')
  await seed(page)
  await page.getByTestId('expand-references').click()
  await expect(page.locator('.node')).toHaveCount(4)
  await page.fill('#search', 'another seed')
  await page.press('#search', 'Enter')
  await page.locator('#results li').first().click()
  await expect(page.locator('.node')).toHaveCount(1)
})
