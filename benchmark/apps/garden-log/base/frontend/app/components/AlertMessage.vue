<script setup lang="ts">
withDefaults(defineProps<{
  tone?: 'error' | 'success' | 'info'
}>(), {
  tone: 'error',
})
</script>

<template>
  <div
    class="alert"
    :class="`alert--${tone}`"
    :role="tone === 'error' ? 'alert' : 'status'"
  >
    <slot />
  </div>
</template>
