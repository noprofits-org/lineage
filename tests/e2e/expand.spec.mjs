import { test, expect } from '@playwright/test'
import * as fixtures from './fixtures.mjs'
import { stubApi } from './helpers.mjs'

async function seedPage(page, path = '/') {
  await page.goto(path)
  await page.fill('#search', 'nucleic')
  await page.press('#search', 'Enter')
  await page.locator('#results li').first().click()
}

test('expand references: nodes, edges, tier-1 disclosure', async ({ page }) => {
  await stubApi(page, fixtures)
  await seedPage(page)
  await page.getByTestId('expand-references').click()
  await expect(page.locator('.node')).toHaveCount(4)
  await expect(page.locator('#status')).toHaveText('showing top 3 of 3 references')
  await expect(page.getByTestId('references-status')).toHaveText(
    'showing top 3 of 3 references',
  )
  await expect(page.getByTestId('citations-status')).toBeHidden()
})

test('disclosure reports when retrievable papers differ from the parent count', async ({ page }) => {
  await stubApi(page, fixtures, {
    '/references': {
      json: {
        offset: 0,
        data: fixtures.REFS.slice(0, 2).map(paper => ({ citedPaper: paper })),
      },
    },
  })
  await seedPage(page)
  await page.getByTestId('expand-references').click()
  await expect(page.locator('#status')).toHaveText(
    'showing 2 of 2 available papers (3 references reported)',
  )
})

test('expand citations: batch of 25 from a 30-pool, load-more without network', async ({ page }) => {
  await stubApi(page, fixtures)
  await seedPage(page)
  let citationCalls = 0
  page.on('request', r => { if (r.url().includes('/citations')) citationCalls++ })
  await page.getByTestId('expand-citations').click()
  await expect(page.locator('.node')).toHaveCount(26)
  await expect(page.locator('#status')).toHaveText('showing top 25 of 30 citations')
  await expect(page.getByTestId('citations-status')).toHaveText(
    'showing top 25 of 30 citations',
  )
  await expect(page.getByTestId('load-more')).toBeVisible()
  await page.getByTestId('load-more').click()
  await expect(page.locator('.node')).toHaveCount(31)
  expect(citationCalls).toBe(1)
})

test('load more fetches the next pool page only after the current pool is exhausted', async ({ page }) => {
  const firstPage = Array.from({ length: 26 }, (_, index) =>
    fixtures.paper(`page1-${index}`, 1970, 200 - index, `Page One ${index}`))
  const secondPage = Array.from({ length: 4 }, (_, index) =>
    fixtures.paper(`page2-${index}`, 1980, 100 - index, `Page Two ${index}`))
  let calls = 0
  await stubApi(page, fixtures, {
    '/citations': url => {
      calls += 1
      expect(url.searchParams.get('limit')).toBe('500')
      return Number(url.searchParams.get('offset')) === 0
        ? {
            json: {
              offset: 0,
              next: 500,
              data: firstPage.map(paper => ({ citingPaper: paper })),
            },
          }
        : {
            json: {
              offset: 500,
              data: secondPage.map(paper => ({ citingPaper: paper })),
            },
          }
    },
  })

  await seedPage(page)
  await page.getByTestId('expand-citations').click()
  await expect(page.locator('#status')).toHaveText(
    'showing top 25 of the first 26 fetched (30 total)',
  )
  await page.getByTestId('load-more').click()
  await expect(page.locator('.node')).toHaveCount(27)
  expect(calls).toBe(1)
  await page.getByTestId('load-more').click()
  await expect(page.locator('.node')).toHaveCount(31)
  expect(calls).toBe(2)
  await expect(page.locator('#status')).toHaveText('showing 30 of 30 citations')
})

test('double-click on expand fires one request', async ({ page }) => {
  await stubApi(page, fixtures)
  await seedPage(page)
  let calls = 0
  page.on('request', r => { if (r.url().includes('/citations')) calls++ })
  await page.getByTestId('expand-citations').click({ clickCount: 2, delay: 30 })
  await expect(page.locator('.node')).toHaveCount(26)
  expect(calls).toBe(1)
})

test('inspector shows relationship lists, abstract, and outbound links', async ({ page }) => {
  await stubApi(page, fixtures)
  await seedPage(page)
  await page.getByTestId('expand-references').click()
  await page.locator('.node[data-id="seed1"] circle.hit').click()
  await expect(page.getByTestId('insp-abstract')).toContainText('deoxyribose')
  await expect(page.getByTestId('rel-cites').locator('li')).toHaveCount(3)
  await expect(page.getByTestId('insp-links')).toContainText('DOI')
})

test('node cap partially admits a 25-paper batch and discloses it', async ({ page }) => {
  await stubApi(page, fixtures)
  await seedPage(page, '/?cap=10')
  await page.getByTestId('expand-citations').click()
  await expect(page.locator('.node')).toHaveCount(10)
  await expect(page.locator('#status')).toContainText('node cap reached — added 9 of 25')
})

test('query-string test hooks cannot raise the production 300-node cap', async ({ page }) => {
  test.setTimeout(60_000)
  const citations = Array.from({ length: 325 }, (_, index) =>
    fixtures.paper(`large-${index}`, 1960 + (index % 50), 500 - index, `Large ${index}`))
  await stubApi(page, fixtures, {
    '/citations': {
      json: {
        offset: 0,
        data: citations.map(paper => ({ citingPaper: paper })),
      },
    },
  })

  await seedPage(page, '/?cap=100000')
  await page.getByTestId('expand-citations').click()
  for (let batch = 0; batch < 11; batch += 1) {
    await page.getByTestId('load-more').click()
  }
  await expect(page.locator('.node')).toHaveCount(300)
  await expect(page.locator('#status')).toContainText(
    'node cap reached — added 24 of 25',
  )
})
