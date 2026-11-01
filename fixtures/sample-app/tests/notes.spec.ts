import { test, expect } from '@playwright/test'
import { signIn } from './helpers'

test.beforeEach(async ({ page, request }) => {
  await request.post('http://127.0.0.1:8731/api/test/reset')
  await signIn(page)
  await expect(page.getByRole('heading', { name: 'Notes' })).toBeVisible()
})

test('lists the seeded notes', async ({ page }) => {
  await expect(page.getByRole('listitem')).toHaveCount(5)
})

test('creates a note', async ({ page }) => {
  await page.getByRole('link', { name: 'New note' }).click()
  await page.getByLabel('Title').fill('Call the plumber')
  await page.getByLabel('Body').fill('Kitchen tap drips.')
  await page.getByRole('button', { name: 'Save' }).click()

  await expect(page).toHaveURL(/\/notes$/)
  await expect(page.getByRole('listitem')).toHaveCount(6)
  await expect(page.getByRole('listitem').first()).toContainText('Call the plumber')
})

test('searches as you type', async ({ page }) => {
  await page.getByLabel('Search').fill('gar')

  await expect(page.getByRole('listitem')).toHaveCount(1)
  await expect(page.getByRole('listitem')).toContainText('Garden plan')
})
