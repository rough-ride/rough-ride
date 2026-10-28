<script setup lang="ts">
import type { Bed, PlantInput } from '~/types/api'

const props = withDefaults(defineProps<{
  beds: Bed[]
  initial?: Partial<PlantInput>
  submitLabel: string
  pending?: boolean
  error?: string | null
}>(), {
  initial: () => ({}),
  pending: false,
  error: null,
})

const emit = defineEmits<{
  submit: [value: PlantInput]
  cancel: []
}>()

const ids = {
  name: useId(),
  variety: useId(),
  bed: useId(),
  spacing: useId(),
  planted: useId(),
  notes: useId(),
  spacingHint: useId(),
}

const form = reactive({
  name: props.initial.name ?? '',
  variety: props.initial.variety ?? '',
  bedId: props.initial.bed_id ? String(props.initial.bed_id) : '',
  spacing: props.initial.spacing_cm != null ? String(props.initial.spacing_cm) : '',
  plantedOn: props.initial.planted_on ?? '',
  notes: props.initial.notes ?? '',
})

const localError = ref<string | null>(null)
const shownError = computed(() => localError.value ?? props.error)

function validate(): string | null {
  if (!form.name.trim()) return 'Name is required.'
  if (!form.bedId) return 'Choose a bed.'
  if (form.spacing !== '') {
    const spacing = Number(form.spacing)
    if (!Number.isInteger(spacing) || spacing < 1 || spacing > 1000) {
      return 'Spacing must be a whole number between 1 and 1000 cm.'
    }
  }
  return null
}

function handleSubmit(): void {
  localError.value = validate()
  if (localError.value) return
  emit('submit', {
    name: form.name.trim(),
    variety: form.variety.trim(),
    bed_id: Number(form.bedId),
    spacing_cm: form.spacing === '' ? null : Number(form.spacing),
    planted_on: form.plantedOn || null,
    notes: form.notes.trim(),
  })
}
</script>

<template>
  <form class="form card" novalidate @submit.prevent="handleSubmit">
    <AlertMessage v-if="shownError">{{ shownError }}</AlertMessage>

    <div class="form__grid">
      <div class="field">
        <label :for="ids.name">Name <span class="field__required" aria-hidden="true">*</span></label>
        <input
          :id="ids.name"
          v-model="form.name"
          type="text"
          name="name"
          maxlength="80"
          required
          autocomplete="off"
          placeholder="Tomato"
        >
      </div>

      <div class="field">
        <label :for="ids.variety">Variety</label>
        <input
          :id="ids.variety"
          v-model="form.variety"
          type="text"
          name="variety"
          maxlength="80"
          autocomplete="off"
          placeholder="Sungold"
        >
      </div>

      <div class="field">
        <label :for="ids.bed">Bed <span class="field__required" aria-hidden="true">*</span></label>
        <select :id="ids.bed" v-model="form.bedId" name="bed" required>
          <option value="" disabled>Choose a bed</option>
          <option v-for="bed in beds" :key="bed.id" :value="String(bed.id)">
            {{ bed.name }}
          </option>
        </select>
      </div>

      <div class="field">
        <label :for="ids.spacing">Spacing (cm)</label>
        <input
          :id="ids.spacing"
          v-model="form.spacing"
          type="number"
          name="spacing_cm"
          min="1"
          max="1000"
          step="1"
          inputmode="numeric"
          :aria-describedby="ids.spacingHint"
        >
        <p :id="ids.spacingHint" class="field__hint">Distance between plants.</p>
      </div>

      <div class="field">
        <label :for="ids.planted">Planted on</label>
        <input :id="ids.planted" v-model="form.plantedOn" type="date" name="planted_on">
      </div>

      <div class="field field--full">
        <label :for="ids.notes">Notes</label>
        <textarea
          :id="ids.notes"
          v-model="form.notes"
          name="notes"
          rows="4"
          maxlength="4000"
          placeholder="Soil, sowing method, anything worth remembering"
        />
      </div>
    </div>

    <div class="form__actions">
      <button type="submit" class="btn btn--primary" :disabled="pending">
        {{ pending ? 'Saving…' : submitLabel }}
      </button>
      <button type="button" class="btn btn--ghost" :disabled="pending" @click="emit('cancel')">
        Cancel
      </button>
    </div>
  </form>
</template>
