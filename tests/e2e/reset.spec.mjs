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
    '/citations': async () => { await gate; return { json: fixtures.routes.citations } },
  })
  await page.goto('/')
  await seed(page)
  await page.getByTestId('expand-citations').click()
  await page.locator('#reset').click()
  release()
  await page.waitForTimeout(300)
  await expect(page.locator('.node')).toHaveCount(0)
})

test('reset drops a graph request that is still queued behind paper details', async ({ page }) => {
  let releasePaper
  let markPaperStarted
  let citationCalls = 0
  const paperGate = new Promise(resolve => { releasePaper = resolve })
  const paperStarted = new Promise(resolve => { markPaperStarted = resolve })
  await stubApi(page, fixtures, {
    '/citations': () => {
      citationCalls += 1
      return { json: fixtures.routes.citations }
    },
    '/paper/seed1': async () => {
      markPaperStarted()
      await paperGate
      return { json: fixtures.routes.paper }
    },
  })
  await page.goto('/')
  await seed(page)
  await paperStarted
  await page.getByTestId('expand-citations').click()
  await page.locator('#reset').click()
  releasePaper()

  await page.waitForTimeout(500)
  expect(citationCalls).toBe(0)
  await expect(page.locator('.node')).toHaveCount(0)
  await expect(page.locator('#status')).toHaveText('ready')
})

test('closing details during expansion does not let completion reopen them', async ({ page }) => {
  let release
  let markStarted
  const gate = new Promise(resolve => { release = resolve })
  const started = new Promise(resolve => { markStarted = resolve })
  await stubApi(page, fixtures, {
    '/citations': async () => {
      markStarted()
      await gate
      return { json: fixtures.routes.citations }
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
