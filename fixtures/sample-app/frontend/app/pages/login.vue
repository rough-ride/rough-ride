<script setup lang="ts">
const { $api } = useNuxtApp()
const token = useCookie<string | null>('token')
const stuckSpinner = useBug('stuck-spinner')

const email = ref('')
const password = ref('')
const loading = ref(false)
const error = ref('')

async function signIn() {
  error.value = ''
  loading.value = true
  const body = { email: email.value, password: password.value }

  if (stuckSpinner) {
    // Planted bug "stuck-spinner": only the prompted 401 case is handled. Any other
    // failure leaves the spinner running, shows nothing and rejects unhandled.
    try {
      const res = await $api<{ token: string }>('/login', { method: 'POST', body })
      token.value = res.token
    } catch (e: any) {
      if (e?.statusCode === 401) {
        error.value = 'Invalid email or password.'
        loading.value = false
        return
      }
      throw e
    }
    loading.value = false
    await nextTick()
    await navigateTo('/notes')
    return
  }

  try {
    const res = await $api<{ token: string }>('/login', { method: 'POST', body })
    token.value = res.token
    await nextTick()
    await navigateTo('/notes')
  } catch (e: any) {
    error.value =
      e?.statusCode === 401
        ? 'Invalid email or password.'
        : 'Could not sign in. Check your connection and try again.'
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <section>
    <h1>Sign in</h1>
    <form @submit.prevent="signIn">
      <label>
        Email
        <input v-model="email" type="email" name="email" autocomplete="username" required />
      </label>
      <label>
        Password
        <input
          v-model="password"
          type="password"
          name="password"
          autocomplete="current-password"
          required
        />
      </label>
      <p v-if="error" role="alert" class="error">{{ error }}</p>
      <button type="submit" :disabled="loading">
        <span v-if="loading" class="spinner" role="status" aria-label="Loading" />
        {{ loading ? 'Signing in...' : 'Sign in' }}
      </button>
    </form>
  </section>
</template>
