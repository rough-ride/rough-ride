<script setup lang="ts">
definePageMeta({ layout: 'auth' })
useHead({ title: 'Sign in' })

const route = useRoute()
const { signIn } = useAuth()

const email = ref('')
const password = ref('')
const pending = ref(false)
const error = ref<string | null>(null)

function safeRedirect(value: unknown): string {
  const target = typeof value === 'string' ? value : ''
  return target.startsWith('/') && !target.startsWith('//') && target !== '/login' ? target : '/'
}

async function handleSubmit(): Promise<void> {
  error.value = null
  if (!email.value.trim() || !password.value) {
    error.value = 'Enter your email and password.'
    return
  }
  pending.value = true
  try {
    await signIn(email.value.trim(), password.value)
    await navigateTo(safeRedirect(route.query.redirect))
  } catch (err) {
    error.value = apiErrorMessage(err, 'Sign-in failed. Please try again.')
    password.value = ''
  } finally {
    pending.value = false
  }
}
</script>

<template>
  <div class="login">
    <div class="login__brand">
      <img src="/favicon.svg" alt="" width="48" height="48">
      <p class="login__name">Garden Log</p>
      <p class="login__tagline">Your plants, harvests and garden jobs in one place.</p>
    </div>

    <form class="card form login__card" novalidate @submit.prevent="handleSubmit">
      <h1>Sign in</h1>
      <AlertMessage v-if="error">{{ error }}</AlertMessage>

      <div class="field">
        <label for="login-email">Email</label>
        <input
          id="login-email"
          v-model="email"
          type="email"
          name="email"
          autocomplete="username"
          required
          autofocus
        >
      </div>

      <div class="field">
        <label for="login-password">Password</label>
        <input
          id="login-password"
          v-model="password"
          type="password"
          name="password"
          autocomplete="current-password"
          required
        >
      </div>

      <button type="submit" class="btn btn--primary btn--block" :disabled="pending">
        {{ pending ? 'Signing in…' : 'Sign in' }}
      </button>
    </form>
  </div>
</template>
