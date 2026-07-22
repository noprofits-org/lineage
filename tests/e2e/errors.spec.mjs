import { test, expect } from '@playwright/test'
import * as fixtures from './fixtures.mjs'
import { stubApi } from './helpers.mjs'

test('404 surfaces immediately with no retry button', async ({ page }) => {
  await stubApi(page, fixtures, { '/paper/search': { status: 404, json: {} } })
  await page.goto('/')
  await page.fill('#search', 'nucleic')
  await page.press('#search', 'Enter')
  await expect(page.locator('#status')).toContainText('paper not found')
  await expect(page.locator('#retry')).toBeHidden()
})

test('a non-retryable expansion error does not promise an unavailable retry', async ({ page }) => {
  await stubApi(page, fixtures, { '/references': { status: 404, json: {} } })
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
    '/paper/search': () => {
      calls++
      return calls === 1
        ? { status: 429, headers: { 'Retry-After': '1' }, json: {} }
        : { json: fixtures.routes.search }
    },
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
    '/citations': () => (healthy ? { json: fixtures.routes.citations } : { status: 503, json: {} }),
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
    '/references': () => (
      referencesHealthy
        ? { json: fixtures.routes.references }
        : { status: 503, json: {} }
    ),
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
  await expect(page.locator('.node[data-id="r1"]')).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('.node')).toHaveCount(29)
  await expect(page.locator('#retry')).toBeHidden()
})

test('paper-detail retry exhaustion offers a manual retry for the missing abstract', async ({ page }) => {
  test.setTimeout(60_000)
  let paperHealthy = false
  await stubApi(page, fixtures, {
    '/paper/seed1': () => (
      paperHealthy
        ? { json: fixtures.routes.paper }
        : { status: 503, json: {} }
    ),
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
    '/citations': () => {
      calls += 1
      return calls === 1
        ? { abort: 'internetdisconnected' }
        : { json: fixtures.routes.citations }
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
