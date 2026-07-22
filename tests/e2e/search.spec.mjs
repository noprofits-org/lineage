import { test, expect } from '@playwright/test'
import * as fixtures from './fixtures.mjs'
import { stubApi } from './helpers.mjs'

test('search shows results; picking one seeds the graph and hides empty state', async ({ page }) => {
  await stubApi(page, fixtures)
  await page.goto('/')
  await page.fill('#search', 'nucleic')
  await page.press('#search', 'Enter')
  const item = page.locator('#results li').first()
  await expect(item).toContainText('Molecular Structure of Nucleic Acids')
  await item.click()
  await expect(page.locator('#results')).toBeHidden()
  await expect(page.locator('#empty')).toBeHidden()
  await expect(page.locator('.node')).toHaveCount(1)
  await expect(page.locator('#inspector')).toBeVisible()
  await expect(page.getByTestId('insp-title')).toContainText('Molecular Structure')
})

test('example query buttons run a search', async ({ page }) => {
  await stubApi(page, fixtures)
  await page.goto('/')
  await page.locator('.example-query').first().click()
  await expect(page.locator('#results li').first()).toBeVisible()
})

test('search results stay inside a narrow viewport', async ({ page }) => {
  await stubApi(page, fixtures)
  await page.setViewportSize({ width: 480, height: 800 })
  await page.goto('/')
  await page.fill('#search', 'nucleic')
  await page.press('#search', 'Enter')
  const box = await page.locator('#results').boundingBox()
  expect(box).not.toBeNull()
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(480)
})

test('empty search results get a plain message', async ({ page }) => {
  await stubApi(page, fixtures, { '/paper/search': { json: { total: 0, offset: 0, data: [] } } })
  await page.goto('/')
  await page.fill('#search', 'zzz')
  await page.press('#search', 'Enter')
  await expect(page.locator('#status')).toContainText('no papers found')
})

test('a newer search hides and supersedes an older in-flight result list', async ({ page }) => {
  let releaseFirst
  let markFirstStarted
  const firstGate = new Promise(resolve => { releaseFirst = resolve })
  const firstStarted = new Promise(resolve => { markFirstStarted = resolve })
  const firstPaper = fixtures.paper('first', 1980, 1, 'First Search Result')
  const secondPaper = fixtures.paper('second', 1990, 2, 'Second Search Result')
  await stubApi(page, fixtures, {
    '/paper/search': async url => {
      const query = url.searchParams.get('query')
      if (query === 'first') {
        markFirstStarted()
        await firstGate
        return { json: { data: [firstPaper] } }
      }
      return { json: { data: [secondPaper] } }
    },
  })

  await page.goto('/')
  await page.fill('#search', 'first')
  await page.press('#search', 'Enter')
  await firstStarted
  await page.fill('#search', 'second')
  await page.press('#search', 'Enter')
  await expect(page.locator('#results')).toBeHidden()
  releaseFirst()

  await expect(page.locator('#results li')).toHaveCount(1, { timeout: 10_000 })
  await expect(page.locator('#results li').first()).toContainText('Second Search Result')
  await expect(page.locator('#results')).not.toContainText('First Search Result')
})
