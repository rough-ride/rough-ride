<script setup lang="ts">
import type { Harvest, Plant } from '~/types/api'

useHead({ title: 'Log harvest' })

const route = useRoute()
const api = useApiClient()
const { data: plants, error: plantsError } = await useApiFetch<Plant[]>('/plants')

const preselected = parseRouteId(route.query.plant)
const today = todayIso()

const form = reactive({
  plantId: preselected && plants.value?.some((p) => p.id === preselected) ? String(preselected) : '',
  weight: '',
  harvestedOn: today,
  notes: '',
})

const pending = ref(false)
const error = ref<string | null>(null)
const lastLogged = ref<Harvest | null>(null)

const plantsByBed = computed(() => {
  const groups = new Map<string, Plant[]>()
  for (const plant of plants.value ?? []) {
    const group = groups.get(plant.bed_name) ?? []
    group.push(plant)
    groups.set(plant.bed_name, group)
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))
})

function plantLabel(plant: Plant): string {
  return plant.variety ? `${plant.name} (${plant.variety})` : plant.name
}

function validate(): string | null {
  if (!form.plantId) return 'Choose a plant.'
  const weight = Number(form.weight)
  if (!form.weight || !Number.isInteger(weight) || weight < 1) {
    return 'Weight must be a whole number of grams, at least 1.'
  }
  if (!form.harvestedOn) return 'Enter the harvest date.'
  if (form.harvestedOn > todayIso()) return 'Harvest date cannot be in the future.'
  return null
}

async function submit(): Promise<void> {
  error.value = validate()
  if (error.value) return
  pending.value = true
  try {
    const harvest = await api<Harvest>('/harvests', {
      method: 'POST',
      body: {
        plant_id: Number(form.plantId),
        weight_grams: Number(form.weight),
        harvested_on: form.harvestedOn,
        notes: form.notes.trim(),
      },
    })
    if (preselected) {
      await navigateTo(`/plants/${harvest.plant_id}`)
      return
    }
    lastLogged.value = harvest
    form.weight = ''
    form.notes = ''
  } catch (err) {
    error.value = apiErrorMessage(err, 'Could not log the harvest.')
  } finally {
    pending.value = false
  }
}
</script>

<template>
  <div class="narrow">
    <PageHeader title="Log harvest" subtitle="Weigh it, write it down, enjoy it." />

    <AlertMessage v-if="plantsError">
      {{ apiErrorMessage(plantsError, 'Could not load plants.') }}
    </AlertMessage>

    <EmptyState
      v-else-if="plants && plants.length === 0"
      title="No plants to harvest yet"
      message="Add a plant first, then log what it produces."
    >
      <NuxtLink to="/plants/new" class="btn btn--primary">Add plant</NuxtLink>
    </EmptyState>

    <form v-else-if="plants" class="form card" novalidate @submit.prevent="submit">
      <AlertMessage v-if="lastLogged" tone="success">
        Logged {{ formatWeight(lastLogged.weight_grams) }} of {{ lastLogged.plant_name }}.
        <NuxtLink :to="`/plants/${lastLogged.plant_id}`" class="link">View plant</NuxtLink>
      </AlertMessage>
      <AlertMessage v-if="error">{{ error }}</AlertMessage>

      <div class="form__grid">
        <div class="field field--full">
          <label for="harvest-plant">Plant <span class="field__required" aria-hidden="true">*</span></label>
          <select id="harvest-plant" v-model="form.plantId" name="plant" required>
            <option value="" disabled>Choose a plant</option>
            <optgroup v-for="[bedName, group] in plantsByBed" :key="bedName" :label="bedName">
              <option v-for="plant in group" :key="plant.id" :value="String(plant.id)">
                {{ plantLabel(plant) }}
              </option>
            </optgroup>
          </select>
        </div>

        <div class="field">
          <label for="harvest-weight">Weight (grams) <span class="field__required" aria-hidden="true">*</span></label>
          <input
            id="harvest-weight"
            v-model="form.weight"
            type="number"
            name="weight_grams"
            min="1"
            step="1"
            inputmode="numeric"
            required
          >
        </div>

        <div class="field">
          <label for="harvest-date">Harvested on <span class="field__required" aria-hidden="true">*</span></label>
          <input
            id="harvest-date"
            v-model="form.harvestedOn"
            type="date"
            name="harvested_on"
            :max="today"
            required
          >
        </div>

        <div class="field field--full">
          <label for="harvest-notes">Notes</label>
          <textarea
            id="harvest-notes"
            v-model="form.notes"
            name="notes"
            rows="3"
            maxlength="2000"
            placeholder="Quality, size, taste"
          />
        </div>
      </div>

      <div class="form__actions">
        <button type="submit" class="btn btn--primary" :disabled="pending">
          {{ pending ? 'Saving…' : 'Log harvest' }}
        </button>
        <NuxtLink :to="preselected ? `/plants/${preselected}` : '/'" class="btn btn--ghost">Cancel</NuxtLink>
      </div>
    </form>
  </div>
</template>
