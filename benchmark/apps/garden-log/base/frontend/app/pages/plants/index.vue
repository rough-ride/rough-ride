<script setup lang="ts">
import type { Bed, Plant } from '~/types/api'

useHead({ title: 'Plants' })

const route = useRoute()
const router = useRouter()

const search = ref(typeof route.query.q === 'string' ? route.query.q : '')
const bedFilter = ref(typeof route.query.bed === 'string' ? route.query.bed : '')

const query = computed(() => {
  const params: Record<string, string> = {}
  if (search.value.trim()) params.q = search.value.trim()
  if (bedFilter.value) params.bed_id = bedFilter.value
  return params
})

const [plantsResult, bedsResult] = await Promise.all([
  useApiFetch<Plant[]>('/plants', { query }),
  useApiFetch<Bed[]>('/beds'),
])

const { data: plants, error: plantsError, status } = plantsResult
const { data: beds } = bedsResult

watch([search, bedFilter], ([q, bed]) => {
  const next: Record<string, string> = {}
  if (q.trim()) next.q = q.trim()
  if (bed) next.bed = bed
  router.replace({ query: next })
})

const filtering = computed(() => Boolean(search.value.trim() || bedFilter.value))
const resultText = computed(() => {
  const count = plants.value?.length ?? 0
  return filtering.value ? `${plural(count, 'plant')} match` : plural(count, 'plant')
})

function clearFilters(): void {
  search.value = ''
  bedFilter.value = ''
}
</script>

<template>
  <div>
    <PageHeader title="Plants" subtitle="Everything growing in the garden.">
      <template #actions>
        <NuxtLink to="/plants/new" class="btn btn--primary">Add plant</NuxtLink>
      </template>
    </PageHeader>

    <form class="filters card" role="search" @submit.prevent>
      <div class="field">
        <label for="plant-search">Search</label>
        <input
          id="plant-search"
          v-model="search"
          type="search"
          name="q"
          placeholder="Search by name"
          autocomplete="off"
        >
      </div>
      <div class="field">
        <label for="plant-bed">Bed</label>
        <select id="plant-bed" v-model="bedFilter" name="bed">
          <option value="">All beds</option>
          <option v-for="bed in beds ?? []" :key="bed.id" :value="String(bed.id)">
            {{ bed.name }}
          </option>
        </select>
      </div>
      <div class="filters__end">
        <button v-if="filtering" type="button" class="btn btn--ghost" @click="clearFilters">
          Clear filters
        </button>
      </div>
    </form>

    <p class="results-count" aria-live="polite">
      <span v-if="status === 'pending'">Loading plants…</span>
      <span v-else-if="plants">{{ resultText }}</span>
    </p>

    <AlertMessage v-if="plantsError">
      {{ apiErrorMessage(plantsError, 'Could not load plants.') }}
    </AlertMessage>

    <ul v-else-if="plants && plants.length" class="plant-grid">
      <li v-for="plant in plants" :key="plant.id" class="plant-card card">
        <h2 class="plant-card__name">
          <NuxtLink :to="`/plants/${plant.id}`">{{ plant.name }}</NuxtLink>
        </h2>
        <p v-if="plant.variety" class="plant-card__variety">{{ plant.variety }}</p>
        <dl class="plant-card__meta">
          <div>
            <dt>Bed</dt>
            <dd>{{ plant.bed_name }}</dd>
          </div>
          <div>
            <dt>Planted</dt>
            <dd>{{ formatDate(plant.planted_on) }}</dd>
          </div>
          <div>
            <dt>Harvested</dt>
            <dd>{{ formatWeight(plant.harvest_grams) }}</dd>
          </div>
        </dl>
      </li>
    </ul>

    <EmptyState
      v-else-if="plants && filtering"
      title="No plants match"
      message="Try a different name or bed."
    >
      <button type="button" class="btn btn--ghost" @click="clearFilters">Clear filters</button>
    </EmptyState>

    <EmptyState
      v-else-if="plants"
      title="No plants yet"
      message="Add the first plant to start your garden journal."
    >
      <NuxtLink to="/plants/new" class="btn btn--primary">Add plant</NuxtLink>
    </EmptyState>
  </div>
</template>
