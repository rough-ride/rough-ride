<script setup lang="ts">
import type { NuxtError } from '#app'

const props = defineProps<{ error: NuxtError }>()

const notFound = computed(() => props.error.statusCode === 404)

useHead({ title: notFound.value ? 'Not found' : 'Error' })

function goHome(): void {
  clearError({ redirect: '/' })
}
</script>

<template>
  <div class="auth-shell">
    <main id="main" class="auth-main">
      <div class="card error-card">
        <p class="error-card__code">{{ error.statusCode }}</p>
        <h1>{{ notFound ? 'Page not found' : 'Something went wrong' }}</h1>
        <p class="muted">
          {{ notFound ? 'That page is not in the garden.' : error.statusMessage || 'Please try again.' }}
        </p>
        <button type="button" class="btn btn--primary" @click="goHome">Back to the dashboard</button>
      </div>
    </main>
  </div>
</template>
