<script setup lang="ts">
defineProps<{
  label: string
  value: string | number
  hint?: string
  to?: string
}>()
</script>

<template>
  <div class="stat">
    <p class="stat__label">{{ label }}</p>
    <p class="stat__value">{{ value }}</p>
    <p v-if="hint" class="stat__hint">{{ hint }}</p>
    <NuxtLink v-if="to" :to="to" class="stat__link">
      View<span class="visually-hidden"> {{ label.toLowerCase() }}</span>
    </NuxtLink>
  </div>
</template>
