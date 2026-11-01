import { test, expect } from '@playwright/test'
import { gotoHydrated, signIn } from './helpers'

test.beforeEach(async ({ request }) => {
  await request.post('http://127.0.0.1:8731/api/test/reset')
})

test('signs in with the demo account', async ({ page }) => {
  await signIn(page)

  await expect(page.getByRole('heading', { name: 'Notes' })).toBeVisible()
})

test('rejects a wrong password', async ({ page }) => {
  await gotoHydrated(page, '/login')
  await page.getByLabel('Email').fill('demo@example.com')
  await page.getByLabel('Password').fill('wrong')
  await page.getByRole('button', { name: 'Sign in' }).click()

  await expect(page.getByRole('alert')).toHaveText('Invalid email or password.')
})
