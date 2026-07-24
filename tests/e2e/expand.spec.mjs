import { test, expect } from '@playwright/test'
import * as fixtures from './fixtures.mjs'
import { stubApi } from './helpers.mjs'

async function seedPage(page, path = '/') {
  await page.goto(path)
  await page.fill('#search', 'nucleic')
  await page.press('#search', 'Enter')
  await page.locator('#results li').first().click()
}

test('expand references: nodes, edges, and provider-truthful disclosure', async ({ page }) => {
  await stubApi(page, fixtures)
  await seedPage(page)
  await page.getByTestId('expand-references').click()
  await expect(page.locator('.node')).toHaveCount(4)
  await expect(page.locator('#status')).toHaveText('showing 3 of 3 known open references')
  await expect(page.getByTestId('references-status')).toHaveText(
    'showing 3 of 3 known open references',
  )
  await expect(page.getByTestId('citations-status')).toBeHidden()
})

test('disclosure reports when retrievable papers differ from the parent count', async ({ page }) => {
  await stubApi(page, fixtures, {
    index: {
      references: {
        json: fixtures.REFS.slice(0, 2).map((paper, index) =>
          fixtures.edge(fixtures.SEED, paper, { oci: `short-ref-${index}` })),
      },
    },
  })
  await seedPage(page)
  await page.getByTestId('expand-references').click()
  await expect(page.locator('#status')).toHaveText('showing 2 of 2 known open references')
  await expect(page.getByTestId('insp-counts')).toContainText('2 known open references')
})

test('expand citations hydrates 25, then hydrates the remaining five without refetching edges', async ({ page }) => {
  let indexCalls = 0
  let candidateDetailCalls = 0
  await stubApi(page, fixtures, {
    index: {
      citations: () => {
        indexCalls += 1
        return { json: fixtures.routes.citations }
      },
    },
    crossref: {
      detail: (url, { doi }, fallback) => {
        if (doi !== fixtures.SEED.doi) candidateDetailCalls += 1
        return { json: fallback }
      },
    },
  })
  await seedPage(page)
  await page.getByTestId('expand-citations').click()
  await expect(page.locator('.node')).toHaveCount(26, { timeout: 10_000 })
  expect(indexCalls).toBe(1)
  expect(candidateDetailCalls).toBe(25)
  await expect(page.locator('#status')).toHaveText(
    'showing 25 representative citations from 30 known open citation links',
  )
  await expect(page.getByTestId('citations-status')).toHaveText(
    'showing 25 representative citations from 30 known open citation links',
  )
  await expect(page.getByTestId('load-more')).toBeVisible()
  await page.getByTestId('load-more').click()
  await expect(page.locator('.node')).toHaveCount(31, { timeout: 10_000 })
  expect(indexCalls).toBe(1)
  expect(candidateDetailCalls).toBe(30)
  await expect(page.locator('#status')).toHaveText('showing 30 of 30 known open citations')
})

test('load more stays available when the other direction still has undisplayed papers', async ({ page }) => {
  await stubApi(page, fixtures)
  await seedPage(page)
  await page.getByTestId('expand-citations').click()      // 25 shown, 5 left in pool
  await expect(page.locator('.node')).toHaveCount(26, { timeout: 10_000 })
  await page.getByTestId('expand-references').click()     // exhausted after 3
  await expect(page.locator('.node')).toHaveCount(29)
  // References are exhausted, but 5 citations remain — the button must not hide.
  await expect(page.getByTestId('load-more')).toBeVisible()
  await page.getByTestId('load-more').click()
  await expect(page.locator('.node')).toHaveCount(34)     // the 5 leftover citations
  await expect(page.getByTestId('load-more')).toBeHidden()
})

test('double-click on expand fires one request', async ({ page }) => {
  await stubApi(page, fixtures)
  await seedPage(page)
  let calls = 0
  page.on('request', request => {
    if (request.url().includes('/index/v2/citations/')) calls += 1
  })
  await page.getByTestId('expand-citations').click({ clickCount: 2, delay: 30 })
  await expect(page.locator('.node')).toHaveCount(26, { timeout: 10_000 })
  expect(calls).toBe(1)
})

test('inspector shows relationship lists, abstract, and outbound links', async ({ page }) => {
  await stubApi(page, fixtures)
  await seedPage(page)
  await page.getByTestId('expand-references').click()
  await page.locator(`${fixtures.idSelector(fixtures.SEED)} circle.hit`).click()
  await expect(page.getByTestId('insp-abstract')).toContainText('deoxyribose')
  await expect(page.getByTestId('rel-cites').locator('li')).toHaveCount(3)
  await expect(page.getByTestId('insp-links')).toContainText('DOI')
  await expect(page.getByTestId('insp-links')).toContainText('Crossref')
  await expect(page.getByTestId('insp-links')).toContainText('OpenCitations')
  await expect(page.getByTestId('insp-links')).not.toContainText('Semantic Scholar')
})

test('node cap partially admits a 25-paper batch and discloses it', async ({ page }) => {
  await stubApi(page, fixtures)
  await seedPage(page, '/?cap=10')
  await page.getByTestId('expand-citations').click()
  await expect(page.locator('.node')).toHaveCount(10, { timeout: 10_000 })
  await expect(page.locator('#status')).toContainText('node cap reached — added 9 of 25')
  await expect(page.getByTestId('expand-citations')).toBeDisabled()
  await expect(page.getByTestId('citations-status')).toContainText('node cap reached')
})

for (const [count, needsConfirmation] of [[5000, false], [5001, true], [25000, true]]) {
  test(`${count.toLocaleString()} links ${needsConfirmation ? 'requires a second activation' : 'loads on the first activation'}`, async ({ page }) => {
    let edgeCalls = 0
    await stubApi(page, fixtures, {
      index: {
        citationCount: { json: [{ count: String(count) }] },
        citations: () => {
          edgeCalls += 1
          return { json: [] }
        },
      },
    })

    await seedPage(page)
    const expand = page.getByTestId('expand-citations')
    await expand.click()
    if (needsConfirmation) {
      await expect(page.locator('#status')).toContainText('activate show citations again to load')
      expect(edgeCalls).toBe(0)
      await expand.click()
    }
    await expect.poll(() => edgeCalls).toBe(1)
  })
}

test('more than 25,000 links hard-stops before downloading edges', async ({ page }) => {
  let edgeCalls = 0
  await stubApi(page, fixtures, {
    index: {
      citationCount: { json: [{ count: '25001' }] },
      citations: () => {
        edgeCalls += 1
        return { json: fixtures.routes.citations }
      },
    },
  })

  await seedPage(page)
  await page.getByTestId('expand-citations').click()
  await expect(page.locator('#status')).toContainText(/25,000|too many|too large/i)
  await expect(page.locator('.node')).toHaveCount(1)
  expect(edgeCalls).toBe(0)
})
