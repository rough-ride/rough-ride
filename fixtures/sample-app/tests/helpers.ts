import type { Page } from '@playwright/test'

// Server-rendered inputs exist before Vue hydrates them, and a value filled before
// hydration is lost. This is the same wait @nuxt/test-utils uses.
export async function gotoHydrated(page: Page, path: string) {
  await page.goto(path)
  await page.waitForFunction(() => (window as any).useNuxtApp?.().isHydrating === false)
}

export async function signIn(page: Page) {
  await gotoHydrated(page, '/login')
  await page.getByLabel('Email').fill('demo@example.com')
  await page.getByLabel('Password').fill('demo-password')
  await page.getByRole('button', { name: 'Sign in' }).click()
}
