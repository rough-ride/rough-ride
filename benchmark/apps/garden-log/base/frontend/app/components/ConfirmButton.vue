<script setup lang="ts">
const props = withDefaults(defineProps<{
  label: string
  question?: string
  confirmLabel?: string
  pending?: boolean
}>(), {
  question: 'Are you sure?',
  confirmLabel: 'Yes, delete',
  pending: false,
})

const emit = defineEmits<{ confirm: [] }>()
const asking = ref(false)
const confirmRef = ref<HTMLButtonElement | null>(null)
const triggerRef = ref<HTMLButtonElement | null>(null)

async function ask(): Promise<void> {
  asking.value = true
  await nextTick()
  confirmRef.value?.focus()
}

async function cancel(): Promise<void> {
  asking.value = false
  await nextTick()
  triggerRef.value?.focus()
}

function confirm(): void {
  if (props.pending) return
  emit('confirm')
}
</script>

<template>
  <div class="confirm">
    <button
      v-if="!asking"
      ref="triggerRef"
      type="button"
      class="btn btn--danger-outline"
      @click="ask"
    >
      {{ label }}
    </button>
    <div v-else class="confirm__box" role="group" :aria-label="label">
      <span class="confirm__question">{{ question }}</span>
      <button
        ref="confirmRef"
        type="button"
        class="btn btn--danger"
        :disabled="pending"
        @click="confirm"
      >
        {{ pending ? 'Deleting…' : confirmLabel }}
      </button>
      <button type="button" class="btn btn--ghost" :disabled="pending" @click="cancel">
        Cancel
      </button>
    </div>
  </div>
</template>
