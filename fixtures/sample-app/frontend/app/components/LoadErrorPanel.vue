<script setup lang="ts">
// Rendered only when the notes list fails to load, through <LazyLoadErrorPanel>, so the
// browser fetches this file only on the error path (used by the module-tracing prototype).
defineEmits<{ retry: [] }>()
</script>

<template>
  <div>
    <p role="alert" class="error">Could not load notes.</p>
    <button type="button" @click="$emit('retry')">Try again</button>
  </div>
</template>
