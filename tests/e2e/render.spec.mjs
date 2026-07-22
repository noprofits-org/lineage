import { test, expect } from '@playwright/test'
import * as fixtures from './fixtures.mjs'
import { stubApi } from './helpers.mjs'

async function seedAndExpandRefs(page) {
  await page.goto('/')
  await page.fill('#search', 'nucleic')
  await page.press('#search', 'Enter')
  await page.locator('#results li').first().click()
  await page.getByTestId('expand-references').click()
  await expect(page.locator('.node')).toHaveCount(4)
}

test('year axis, dated ordering, undated gutter, hairline edges', async ({ page }) => {
  await stubApi(page, fixtures)
  await seedAndExpandRefs(page)
  await expect(page.locator('.axis')).toBeVisible()
  await expect(page.locator('.edge')).toHaveCount(3)
  const cx = async id => Number(await page.locator(`.node[data-id="${id}"] circle.dot`).getAttribute('cx'))
  expect(await cx('r1')).toBeLessThan(await cx('seed1'))
  expect(await cx('r3')).toBeGreaterThan(await cx('seed1'))
  await expect(page.locator('.node[data-id="r3"]')).toHaveClass(/undated/)
  await expect(page.locator('.gutter-label')).toHaveText('undated')
  const yearLabels = await page.locator('.axis .tick text').allTextContents()
  expect(new Set(yearLabels).size).toBe(yearLabels.length)
})

test('selection paints accent classes and cited-end ticks appear on selection', async ({ page }) => {
  await stubApi(page, fixtures)
  await seedAndExpandRefs(page)
  await page.locator('.node[data-id="seed1"] circle.hit').click()
  await expect(page.locator('.node[data-id="seed1"]')).toHaveClass(/selected/)
  await expect(page.locator('.edge.selected-edge')).toHaveCount(3)
  await expect(page.locator('.edge.selected-edge').first()).toHaveAttribute('marker-end', 'url(#tick)')
})

test('resting edges are arrowless and hover adds a cited-end tick', async ({ page }) => {
  await stubApi(page, fixtures)
  await seedAndExpandRefs(page)
  await page.locator('.node[data-id="r1"] circle.hit').click()
  await expect(page.locator('.edge[marker-end="url(#tick)"]')).toHaveCount(1)

  await page.locator('.node[data-id="r2"] circle.hit').hover()
  await expect(page.locator('.edge[marker-end="url(#tick)"]')).toHaveCount(2)
})

test('widening the dated domain preserves the selected paper x-position when feasible', async ({ page }) => {
  await stubApi(page, fixtures)
  await page.goto('/')
  await page.fill('#search', 'nucleic')
  await page.press('#search', 'Enter')
  await page.locator('#results li').first().click()
  const seedDot = page.locator('.node[data-id="seed1"] circle.dot')
  const before = Number(await seedDot.getAttribute('cx'))

  await page.getByTestId('expand-citations').click()
  await expect(page.locator('.node')).toHaveCount(26)
  const after = Number(await seedDot.getAttribute('cx'))
  expect(after).toBeCloseTo(before, 5)
})

test('same-year and future-dated citations rely on the cited-end tick, not chronology', async ({ page }) => {
  const sameYear = fixtures.paper('same-year', 1953, 4, 'Same Year Reference')
  const futureDated = fixtures.paper('future-dated', 1962, 3, 'Future Dated Reference')
  await stubApi(page, fixtures, {
    '/references': {
      json: {
        offset: 0,
        data: [sameYear, futureDated].map(paper => ({ citedPaper: paper })),
      },
    },
  })
  await page.goto('/')
  await page.fill('#search', 'nucleic')
  await page.press('#search', 'Enter')
  await page.locator('#results li').first().click()
  await page.getByTestId('expand-references').click()
  await expect(page.locator('.node')).toHaveCount(3)
  const x = async id => Number(
    await page.locator(`.node[data-id="${id}"] circle.dot`).getAttribute('cx'),
  )
  expect(await x('same-year')).toBeCloseTo(await x('seed1'), 5)
  expect(await x('future-dated')).toBeGreaterThan(await x('seed1'))
  await expect(page.locator('.edge[marker-end="url(#tick)"]')).toHaveCount(2)
})

test('hit areas are at least 24px even though dots are small', async ({ page }) => {
  await stubApi(page, fixtures)
  await seedAndExpandRefs(page)
  const r = await page.locator('.node[data-id="seed1"] circle.hit').getAttribute('r')
  expect(Number(r)).toBeGreaterThanOrEqual(12)
})

test('resizing recomputes the year scale and keeps the undated gutter visible', async ({ page }) => {
  await stubApi(page, fixtures)
  await seedAndExpandRefs(page)
  const before = Number(await page.locator('.node[data-id="r3"] circle.dot').getAttribute('cx'))
  await page.setViewportSize({ width: 700, height: 700 })
  await expect.poll(async () => Number(
    await page.locator('.node[data-id="r3"] circle.dot').getAttribute('cx'),
  )).toBeLessThan(before)
})
