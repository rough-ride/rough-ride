<script setup lang="ts">
defineProps<{
  title: string
  message?: string
}>()
</script>

<template>
  <div class="empty">
    <p class="empty__title">{{ title }}</p>
    <p v-if="message" class="empty__message">{{ message }}</p>
    <div v-if="$slots.default" class="empty__action">
      <slot />
    </div>
  </div>
</template>
