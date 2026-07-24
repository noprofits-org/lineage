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

test('a paper can be dragged vertically without moving off its year', async ({ page }) => {
  await stubApi(page, fixtures)
  await seedAndExpandRefs(page)
  const node = page.locator(fixtures.idSelector(fixtures.REFS[0]))
  const hit = node.locator('circle.hit')
  const beforeX = Number(await hit.getAttribute('cx'))
  const beforeY = Number(await hit.getAttribute('cy'))
  const box = await hit.boundingBox()
  expect(box).not.toBeNull()

  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 80, { steps: 5 })
  await page.mouse.up()

  await expect.poll(async () => Number(await hit.getAttribute('cy'))).toBeGreaterThan(beforeY + 50)
  expect(Number(await hit.getAttribute('cx'))).toBeCloseTo(beforeX, 5)
  await expect(node).toHaveClass(/positioned/)

  await page.locator('#reset-layout').click()
  await expect(node).not.toHaveClass(/positioned/)
  await expect(page.locator('#status')).toHaveText('automatic vertical layout restored')
})

test('node spacing control increases separation within a crowded year', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const sameYear = Array.from({ length: 4 }, (_, index) =>
    fixtures.paper(`same-year-spacing-${index}`, 1950, index + 1, `Same Year ${index}`))
  const details = new Map(sameYear.map(paper => [
    paper.doi,
    fixtures.crossrefDetail(paper),
  ]))
  await stubApi(page, fixtures, {
    index: {
      referenceCount: { json: [{ count: String(sameYear.length) }] },
      references: {
        json: sameYear.map((paper, index) =>
          fixtures.edge(fixtures.SEED, paper, { oci: `spacing-${index}` })),
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
  await expect(page.locator('.node')).toHaveCount(5)

  const sameYearDots = page.locator(
    sameYear.map(paper => `${fixtures.idSelector(paper)} circle.dot`).join(','),
  )
  const minimumGap = async () => {
    const positions = (await sameYearDots.all()).map(async dot =>
      Number(await dot.getAttribute('cy')))
    const sorted = (await Promise.all(positions)).sort((a, b) => a - b)
    return Math.min(...sorted.slice(1).map((value, index) => value - sorted[index]))
  }
  const compactGap = await minimumGap()
  await page.getByTestId('node-spacing').evaluate(input => {
    input.value = '32'
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })

  await expect(page.locator('#node-spacing-value')).toHaveText('32px')
  await expect(page.getByTestId('node-spacing')).toHaveAttribute(
    'aria-valuetext',
    '32 pixels between nodes',
  )
  await expect.poll(minimumGap).toBeGreaterThan(compactGap + 20)
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
