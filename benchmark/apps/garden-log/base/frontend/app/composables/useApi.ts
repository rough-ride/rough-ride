import type { UseFetchOptions } from 'nuxt/app'

/** API base URL: loopback during SSR, localhost in the browser. */
export function useApiBase(): string {
  const config = useRuntimeConfig()
  return import.meta.server ? config.apiBaseServer : config.public.apiBase
}

/** Forwards the browser's cookie header when rendering on the server. */
function useForwardedHeaders(): Record<string, string> {
  return import.meta.server ? useRequestHeaders(['cookie']) : {}
}

function handleUnauthorized(status: number | undefined): void {
  if (status === 401 && import.meta.client) {
    useCurrentUser().value = null
    navigateTo('/login')
  }
}

/**
 * `useFetch` against the API with credentials and SSR cookie forwarding.
 * The base URL lives in the custom `$fetch` so the cache key matches on server and client.
 */
export function useApiFetch<T>(
  path: string | (() => string),
  options: UseFetchOptions<T> = {},
) {
  return useFetch(path, {
    ...options,
    $fetch: useApiClient() as typeof $fetch,
  })
}

/** A `$fetch` client for mutations triggered by user actions. */
export function useApiClient() {
  return $fetch.create({
    baseURL: useApiBase(),
    credentials: 'include',
    headers: useForwardedHeaders(),
    onResponseError({ response }) {
      handleUnauthorized(response.status)
    },
  })
}

interface ValidationIssue {
  loc?: (string | number)[]
  msg?: string
}

/** Turns a FastAPI error response into one readable sentence. */
export function apiErrorMessage(error: unknown, fallback = 'Something went wrong. Please try again.'): string {
  const data = (error as { data?: { detail?: unknown } } | null)?.data
  const detail = data?.detail
  if (typeof detail === 'string') return detail
  if (Array.isArray(detail) && detail.length > 0) {
    return (detail as ValidationIssue[])
      .map((issue) => {
        const field = issue.loc?.filter((part) => part !== 'body').join('.')
        const message = (issue.msg ?? 'is invalid').replace(/^Value error, /, '')
        return field ? `${humanizeField(String(field))}: ${message}` : message
      })
      .join(' ')
  }
  const statusCode = (error as { statusCode?: number } | null)?.statusCode
  if (statusCode === undefined) return 'The garden server could not be reached.'
  return fallback
}

function humanizeField(field: string): string {
  const text = field.replace(/_/g, ' ')
  return text.charAt(0).toUpperCase() + text.slice(1)
}
