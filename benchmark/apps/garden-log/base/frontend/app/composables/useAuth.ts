import type { SessionResponse, User } from '~/types/api'

export function useCurrentUser() {
  return useState<User | null>('current-user', () => null)
}

/** Asks the API who is signed in; returns null when nobody is. */
export async function loadCurrentUser(): Promise<User | null> {
  const baseURL = useApiBase()
  const headers = import.meta.server ? useRequestHeaders(['cookie']) : {}
  if (import.meta.server && !headers.cookie) return null
  try {
    const session = await $fetch<SessionResponse>('/auth/me', {
      baseURL,
      headers,
      credentials: 'include',
    })
    return session.user
  } catch {
    return null
  }
}

export function useAuth() {
  const user = useCurrentUser()
  const api = useApiClient()

  async function signIn(email: string, password: string): Promise<User> {
    const session = await api<SessionResponse>('/auth/login', {
      method: 'POST',
      body: { email, password },
    })
    if (!session.user) throw new Error('Sign-in failed.')
    user.value = session.user
    return session.user
  }

  async function signOut(): Promise<void> {
    try {
      await api('/auth/logout', { method: 'POST' })
    } finally {
      user.value = null
      await navigateTo('/login')
    }
  }

  return { user, signIn, signOut }
}
