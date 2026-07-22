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
  await page.locator('.node[data-id="seed1"]').focus()
  await page.locator('.node[data-id="seed1"]').press('ArrowLeft')
  const focused = await page.evaluate(() => document.activeElement?.getAttribute('data-id'))
  expect(['r1', 'r2']).toContain(focused)
  await expect(page.locator(`.node[data-id="${focused}"]`)).toHaveAttribute('tabindex', '0')
  await expect(page.locator('.node[tabindex="0"]')).toHaveCount(1)
  await expect(page.locator('.node[data-id="seed1"]')).toHaveAttribute('tabindex', '-1')
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
  const seed = page.locator('.node[data-id="seed1"]')
  await expect(seed).toHaveAttribute('aria-label', /1953.*Molecular Structure/)
  await expect(page.locator('.node[tabindex="0"]')).toHaveCount(1)
})

test('reduced motion settles layout before the first assertion', async ({ page }) => {
  await stubApi(page, fixtures)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/')
  await seedAndExpand(page)
  const y1 = await page.locator('.node[data-id="r1"] circle.dot').getAttribute('cy')
  await page.waitForTimeout(400)
  const y2 = await page.locator('.node[data-id="r1"] circle.dot').getAttribute('cy')
  expect(y1).toBe(y2)
})
