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
  const cx = async paper => Number(
    await page.locator(`${fixtures.idSelector(paper)} circle.dot`).getAttribute('cx'),
  )
  expect(await cx(fixtures.REFS[0])).toBeLessThan(await cx(fixtures.SEED))
  expect(await cx(fixtures.REFS[2])).toBeGreaterThan(await cx(fixtures.SEED))
  await expect(page.locator(fixtures.idSelector(fixtures.REFS[2]))).toHaveClass(/undated/)
  await expect(page.locator('.gutter-label')).toHaveText('undated')
  const yearLabels = await page.locator('.axis .tick text').allTextContents()
  expect(new Set(yearLabels).size).toBe(yearLabels.length)
})

test('selection paints accent classes and cited-end ticks appear on selection', async ({ page }) => {
  await stubApi(page, fixtures)
  await seedAndExpandRefs(page)
  await page.locator(`${fixtures.idSelector(fixtures.SEED)} circle.hit`).click()
  await expect(page.locator(fixtures.idSelector(fixtures.SEED))).toHaveClass(/selected/)
  await expect(page.locator('.edge.selected-edge')).toHaveCount(3)
  await expect(page.locator('.edge.selected-edge').first()).toHaveAttribute('marker-end', 'url(#tick)')
})

test('resting edges are arrowless and hover adds a cited-end tick', async ({ page }) => {
  await stubApi(page, fixtures)
  await seedAndExpandRefs(page)
  await page.locator(`${fixtures.idSelector(fixtures.REFS[0])} circle.hit`).click()
  await expect(page.locator('.edge[marker-end="url(#tick)"]')).toHaveCount(1)

  await page.locator(`${fixtures.idSelector(fixtures.REFS[1])} circle.hit`).hover()
  await expect(page.locator('.edge[marker-end="url(#tick)"]')).toHaveCount(2)
})

test('widening the dated domain preserves the selected paper x-position when feasible', async ({ page }) => {
  await stubApi(page, fixtures)
  await page.goto('/')
  await page.fill('#search', 'nucleic')
  await page.press('#search', 'Enter')
  await page.locator('#results li').first().click()
  const seedDot = page.locator(`${fixtures.idSelector(fixtures.SEED)} circle.dot`)
  const before = Number(await seedDot.getAttribute('cx'))

  await page.getByTestId('expand-citations').click()
  await expect(page.locator('.node')).toHaveCount(26, { timeout: 10_000 })
  const after = Number(await seedDot.getAttribute('cx'))
  expect(after).toBeCloseTo(before, 5)
})

test('same-year and future-dated citations rely on the cited-end tick, not chronology', async ({ page }) => {
  const sameYear = fixtures.paper('same-year', 1953, 4, 'Same Year Reference')
  const futureDated = fixtures.paper('future-dated', 1962, 3, 'Future Dated Reference')
  const details = new Map([sameYear, futureDated].map(paper => [
    paper.doi,
    fixtures.crossrefDetail(paper),
  ]))
  await stubApi(page, fixtures, {
    index: {
      references: {
        json: [sameYear, futureDated].map((paper, index) =>
          fixtures.edge(fixtures.SEED, paper, { oci: `edge-${index}` })),
      },
    },
    crossref: {
      detail: (url, { doi }, fallback) => ({ json: details.get(doi) ?? fallback }),
    },
  })
  await page.goto('/')
  await page.fill('#search', 'nucleic')
  await page.press('#search', 'Enter')
  await page.locator('#results li').first().click()
  await page.getByTestId('expand-references').click()
  await expect(page.locator('.node')).toHaveCount(3)
  const x = async paper => Number(
    await page.locator(`${fixtures.idSelector(paper)} circle.dot`).getAttribute('cx'),
  )
  expect(await x(sameYear)).toBeCloseTo(await x(fixtures.SEED), 5)
  expect(await x(futureDated)).toBeGreaterThan(await x(fixtures.SEED))
  await expect(page.locator('.edge[marker-end="url(#tick)"]')).toHaveCount(2)
})

test('hit areas are at least 24px even though dots are small', async ({ page }) => {
  await stubApi(page, fixtures)
  await seedAndExpandRefs(page)
  const r = await page.locator(`${fixtures.idSelector(fixtures.SEED)} circle.hit`).getAttribute('r')
  expect(Number(r)).toBeGreaterThanOrEqual(12)
})

test('resizing recomputes the year scale and keeps the undated gutter visible', async ({ page }) => {
  await stubApi(page, fixtures)
  await seedAndExpandRefs(page)
  const undatedDot = page.locator(`${fixtures.idSelector(fixtures.REFS[2])} circle.dot`)
  const before = Number(await undatedDot.getAttribute('cx'))
  await page.setViewportSize({ width: 700, height: 700 })
  await expect.poll(async () => Number(
    await undatedDot.getAttribute('cx'),
  )).toBeLessThan(before)
})
