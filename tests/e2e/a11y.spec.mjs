import { test, expect } from '@playwright/test'
import * as fixtures from './fixtures.mjs'
import { stubApi } from './helpers.mjs'

async function seedAndExpand(page) {
  await page.fill('#search', 'nucleic')
  await page.press('#search', 'Enter')
  await page.locator('#results li').first().press('Enter')
  await page.getByTestId('expand-references').focus()
  await page.getByTestId('expand-references').press('Enter')
  await expect(page.locator('.node')).toHaveCount(4)
}

test('keyboard-only: result selection, arrow navigation, and Enter selection', async ({ page }) => {
  await stubApi(page, fixtures)
  await page.goto('/')
  await seedAndExpand(page)
  await page.locator(fixtures.idSelector(fixtures.SEED)).focus()
  await page.locator(fixtures.idSelector(fixtures.SEED)).press('ArrowLeft')
  const focused = await page.evaluate(() => document.activeElement?.getAttribute('data-id'))
  expect(fixtures.REFS.slice(0, 2).map(paper => paper.paperId)).toContain(focused)
  await expect(page.locator(`.node[data-id="${focused}"]`)).toHaveAttribute('tabindex', '0')
  await expect(page.locator('.node[tabindex="0"]')).toHaveCount(1)
  await expect(page.locator(fixtures.idSelector(fixtures.SEED))).toHaveAttribute('tabindex', '-1')
  await page.setViewportSize({ width: 900, height: 700 })
  await expect(page.locator(`.node[data-id="${focused}"]`)).toHaveAttribute('tabindex', '0')
  await expect(page.locator('.node[tabindex="0"]')).toHaveCount(1)
  await page.keyboard.press('Enter')
  await expect(page.locator(`.node[data-id="${focused}"]`)).toHaveClass(/selected/)
})

test('nodes expose descriptive aria labels and one roving tab stop', async ({ page }) => {
  await stubApi(page, fixtures)
  await page.goto('/')
  await seedAndExpand(page)
  const seed = page.locator(fixtures.idSelector(fixtures.SEED))
  await expect(seed).toHaveAttribute('aria-label', /1953.*Molecular Structure/)
  await expect(page.locator('.node[tabindex="0"]')).toHaveCount(1)
})

test('reduced motion settles layout before the first assertion', async ({ page }) => {
  await stubApi(page, fixtures)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/')
  await seedAndExpand(page)
  const referenceDot = page.locator(`${fixtures.idSelector(fixtures.REFS[0])} circle.dot`)
  const y1 = await referenceDot.getAttribute('cy')
  await page.waitForTimeout(400)
  const y2 = await referenceDot.getAttribute('cy')
  expect(y1).toBe(y2)
})

test('search results list is arrow-key navigable with roving aria-selected', async ({ page }) => {
  const extra = [
    fixtures.paper('alt1', 1962, 12, 'Alternative Paper One'),
    fixtures.paper('alt2', 1971, 8, 'Alternative Paper Two'),
  ]
  await stubApi(page, fixtures, {
    crossref: { search: { json: fixtures.crossrefSearch([fixtures.SEED, ...extra]) } },
  })
  await page.goto('/')
  await page.fill('#search', 'nucleic')
  await page.press('#search', 'Enter')

  const items = page.locator('#results li')
  await expect(items).toHaveCount(3)
  await expect(items.nth(0)).toBeFocused()
  await expect(items.nth(0)).toHaveAttribute('aria-selected', 'true')

  await page.keyboard.press('ArrowDown')
  await expect(items.nth(1)).toBeFocused()
  await expect(items.nth(1)).toHaveAttribute('aria-selected', 'true')
  await expect(items.nth(0)).toHaveAttribute('aria-selected', 'false')

  await page.keyboard.press('ArrowDown')
  await expect(items.nth(2)).toBeFocused()
  await page.keyboard.press('ArrowUp')
  await expect(items.nth(1)).toBeFocused()

  await page.keyboard.press('Enter')   // seeds from the focused result
  await expect(page.locator(fixtures.idSelector(extra[0]))).toHaveCount(1)
  await expect(page.locator('#results')).toBeHidden()
})

test('reduced motion: domain-widening rescale repositions instantly', async ({ page }) => {
  await stubApi(page, fixtures)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/')
  await page.fill('#search', 'nucleic')
  await page.press('#search', 'Enter')
  await page.locator('#results li').first().press('Enter')

  const seedDot = page.locator(`${fixtures.idSelector(fixtures.SEED)} circle.dot`)
  const cxBefore = await seedDot.getAttribute('cx')

  // Expanding references introduces 1949–1950 papers, widening the domain.
  await page.getByTestId('expand-references').focus()
  await page.getByTestId('expand-references').press('Enter')
  await expect(page.locator('.node')).toHaveCount(4)

  const cxAfter = await seedDot.getAttribute('cx')
  const cyAfter = await seedDot.getAttribute('cy')
  // Spec's minimal-displacement guarantee: the selected node keeps its exact
  // screen position while the domain stretches around it.
  expect(cxAfter).toBe(cxBefore)

  // Under reduced motion the widened layout must already be settled: no
  // position drift in either axis after the first paint.
  await page.waitForTimeout(400)
  expect(await seedDot.getAttribute('cx')).toBe(cxAfter)
  expect(await seedDot.getAttribute('cy')).toBe(cyAfter)
  const r1After = await page.locator(`${fixtures.idSelector(fixtures.REFS[0])} circle.dot`).getAttribute('cx')
  expect(Number(r1After)).toBeLessThan(Number(cxAfter))   // widened domain places 1949 left of 1953
})

test('large-expansion confirmation is announced, keyboard operable, and reset-bound', async ({ page }) => {
  let edgeCalls = 0
  await stubApi(page, fixtures, {
    index: {
      citationCount: { json: [{ count: '5001' }] },
      citations: () => {
        edgeCalls += 1
        return { json: [] }
      },
    },
  })
  await page.goto('/')
  await page.fill('#search', 'nucleic')
  await page.press('#search', 'Enter')
  await page.locator('#results li').first().press('Enter')

  const expand = page.getByTestId('expand-citations')
  await expand.focus()
  await expand.press('Enter')
  await expect(page.locator('#status')).toContainText('activate show citations again to load')
  expect(edgeCalls).toBe(0)

  await page.locator('#reset').click()
  await page.fill('#search', 'nucleic')
  await page.press('#search', 'Enter')
  await page.locator('#results li').first().press('Enter')
  await expand.focus()
  await expand.press('Enter')
  await expect(page.locator('#status')).toContainText('activate show citations again to load')
  expect(edgeCalls).toBe(0)
  await expand.press('Enter')
  await expect.poll(() => edgeCalls).toBe(1)
})
