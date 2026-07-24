import { test, expect } from '@playwright/test'
import * as fixtures from './fixtures.mjs'
import { stubApi } from './helpers.mjs'

test('shell renders: wordmark, search, empty state with convention text', async ({ page }) => {
  await stubApi(page, fixtures)
  await page.goto('/')
  await expect(page.locator('.wordmark')).toHaveText('Lineage')
  await expect(page.locator('#search')).toBeVisible()
  await expect(page.locator('#empty')).toContainText('Search for a paper')
  await expect(page.locator('#empty .convention')).toContainText('from the citing paper to the cited paper')
  await expect(page.locator('.example-query')).toHaveCount(3)
  await expect(page.locator('#layout-controls')).toBeHidden()
  await expect(page.getByTestId('node-spacing')).toHaveAttribute('min', '8')
  await expect(page.getByTestId('node-spacing')).toHaveAttribute('max', '32')
  await page.locator('#about summary').click()
  await expect(page.locator('#about .about-copy')).toContainText(
    'Edges encode citation, from the citing paper to the cited paper',
  )
  await expect(page.locator('#about .about-copy')).toContainText(
    'Drag papers up or down',
  )
  await expect(page.locator('#status')).toHaveText('ready')
})
