import type { Sunlight } from '~/types/api'

const dateFormatter = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
})

/** Formats an ISO date (YYYY-MM-DD) without shifting it by time zone. */
export function formatDate(value: string | null | undefined): string {
  if (!value) return '–'
  const date = new Date(`${value.slice(0, 10)}T00:00:00Z`)
  return Number.isNaN(date.getTime()) ? value : dateFormatter.format(date)
}

export function formatWeight(grams: number | null | undefined): string {
  if (grams === null || grams === undefined) return '–'
  if (grams >= 1000) {
    const kg = grams / 1000
    return `${kg.toLocaleString('en-GB', { maximumFractionDigits: 2 })} kg`
  }
  return `${grams.toLocaleString('en-GB')} g`
}

export function todayIso(): string {
  const now = new Date()
  const offset = now.getTimezoneOffset() * 60_000
  return new Date(now.getTime() - offset).toISOString().slice(0, 10)
}

export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`
}

export const SUNLIGHT_LABELS: Record<Sunlight, string> = {
  full_sun: 'Full sun',
  partial_shade: 'Partial shade',
  shade: 'Shade',
}

/** Days from today until an ISO date; negative when it is in the past. */
export function daysUntil(value: string): number {
  const target = Date.parse(`${value}T00:00:00Z`)
  const today = Date.parse(`${todayIso()}T00:00:00Z`)
  return Math.round((target - today) / 86_400_000)
}

export function dueLabel(value: string): string {
  const days = daysUntil(value)
  if (days === 0) return 'Due today'
  if (days === 1) return 'Due tomorrow'
  if (days === -1) return 'Overdue by 1 day'
  if (days < 0) return `Overdue by ${-days} days`
  return `Due in ${days} days`
}

export function parseRouteId(value: unknown): number | null {
  const raw = Array.isArray(value) ? value[0] : value
  const id = Number(raw)
  return Number.isInteger(id) && id > 0 ? id : null
}
