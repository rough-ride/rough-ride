<script setup lang="ts">
import type { Bed, Plant, PlantInput } from '~/types/api'

useHead({ title: 'Add plant' })

const route = useRoute()
const api = useApiClient()
const { data: beds, error: bedsError } = await useApiFetch<Bed[]>('/beds')

const pending = ref(false)
const error = ref<string | null>(null)

const initial = computed<Partial<PlantInput>>(() => {
  const bedId = parseRouteId(route.query.bed)
  if (bedId && beds.value?.some((bed) => bed.id === bedId)) return { bed_id: bedId }
  if (beds.value?.length === 1) return { bed_id: beds.value[0]!.id }
  return {}
})

async function save(value: PlantInput): Promise<void> {
  pending.value = true
  error.value = null
  try {
    const plant = await api<Plant>('/plants', { method: 'POST', body: value })
    await navigateTo(`/plants/${plant.id}`)
  } catch (err) {
    error.value = apiErrorMessage(err, 'Could not save the plant.')
  } finally {
    pending.value = false
  }
}
</script>

<template>
  <div class="narrow">
    <PageHeader title="Add plant" subtitle="Record something new in the garden.">
      <template #before>
        <NuxtLink to="/plants" class="back-link">← All plants</NuxtLink>
      </template>
    </PageHeader>

    <AlertMessage v-if="bedsError">
      {{ apiErrorMessage(bedsError, 'Could not load beds.') }}
    </AlertMessage>

    <EmptyState
      v-else-if="beds && beds.length === 0"
      title="Create a bed first"
      message="Every plant belongs to a bed. Add one, then come back to add your plant."
    >
      <NuxtLink to="/beds" class="btn btn--primary">Set up beds</NuxtLink>
    </EmptyState>

    <PlantForm
      v-else-if="beds"
      :beds="beds"
      :initial="initial"
      submit-label="Save plant"
      :pending="pending"
      :error="error"
      @submit="save"
      @cancel="navigateTo('/plants')"
    />
  </div>
</template>
