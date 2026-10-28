<script setup lang="ts">
import type { Bed, Harvest, PlantDetail, PlantInput } from '~/types/api'

const route = useRoute()
const api = useApiClient()
const plantId = parseRouteId(route.params.id)

if (plantId === null) {
  throw createError({ statusCode: 404, statusMessage: 'Plant not found' })
}

const [plantResult, bedsResult] = await Promise.all([
  useApiFetch<PlantDetail>(`/plants/${plantId}`),
  useApiFetch<Bed[]>('/beds'),
])

const { data: plant, error: plantError, refresh } = plantResult
const { data: beds } = bedsResult

if (plantError.value?.statusCode === 404) {
  throw createError({ statusCode: 404, statusMessage: 'Plant not found' })
}

useHead({ title: () => plant.value?.name ?? 'Plant' })

const editing = ref(route.query.edit === '1')
const saving = ref(false)
const saveError = ref<string | null>(null)
const deleting = ref(false)
const deleteError = ref<string | null>(null)
const removingHarvestId = ref<number | null>(null)
const harvestError = ref<string | null>(null)
const notice = ref<string | null>(null)

const editInitial = computed<Partial<PlantInput>>(() => ({
  name: plant.value?.name,
  variety: plant.value?.variety,
  bed_id: plant.value?.bed_id,
  spacing_cm: plant.value?.spacing_cm,
  planted_on: plant.value?.planted_on,
  notes: plant.value?.notes,
}))

const averageHarvest = computed(() => {
  const p = plant.value
  if (!p || p.harvest_count === 0) return null
  return Math.round(p.harvest_grams / p.harvest_count)
})

function startEditing(): void {
  notice.value = null
  saveError.value = null
  editing.value = true
}

function stopEditing(): void {
  editing.value = false
  saveError.value = null
}

async function saveChanges(value: PlantInput): Promise<void> {
  saving.value = true
  saveError.value = null
  try {
    await api(`/plants/${plantId}`, { method: 'PUT', body: value })
    await refresh()
    editing.value = false
    notice.value = 'Changes saved.'
  } catch (err) {
    saveError.value = apiErrorMessage(err, 'Could not save changes.')
  } finally {
    saving.value = false
  }
}

async function deletePlant(): Promise<void> {
  deleting.value = true
  deleteError.value = null
  try {
    await api(`/plants/${plantId}`, { method: 'DELETE' })
    await navigateTo('/plants')
  } catch (err) {
    deleteError.value = apiErrorMessage(err, 'Could not delete the plant.')
    deleting.value = false
  }
}

async function removeHarvest(harvest: Harvest): Promise<void> {
  const label = `${formatWeight(harvest.weight_grams)} on ${formatDate(harvest.harvested_on)}`
  if (!window.confirm(`Delete the harvest of ${label}?`)) return
  removingHarvestId.value = harvest.id
  harvestError.value = null
  try {
    await api(`/harvests/${harvest.id}`, { method: 'DELETE' })
    await refresh()
  } catch (err) {
    harvestError.value = apiErrorMessage(err, 'Could not delete the harvest.')
  } finally {
    removingHarvestId.value = null
  }
}
</script>

<template>
  <div>
    <AlertMessage v-if="plantError">
      {{ apiErrorMessage(plantError, 'Could not load this plant.') }}
    </AlertMessage>

    <template v-else-if="plant">
      <PageHeader
        :title="editing ? `Edit ${plant.name}` : plant.name"
        :subtitle="editing ? 'Update the details below.' : plant.variety || undefined"
      >
        <template #before>
          <NuxtLink to="/plants" class="back-link">← All plants</NuxtLink>
        </template>
        <template v-if="!editing" #actions>
          <NuxtLink :to="{ path: '/harvests/new', query: { plant: plant.id } }" class="btn btn--ghost">
            Log harvest
          </NuxtLink>
          <button type="button" class="btn btn--primary" @click="startEditing">Edit</button>
        </template>
      </PageHeader>

      <AlertMessage v-if="notice" tone="success">{{ notice }}</AlertMessage>

      <div v-if="editing" class="narrow">
        <PlantForm
          :beds="beds ?? []"
          :initial="editInitial"
          submit-label="Save changes"
          :pending="saving"
          :error="saveError"
          @submit="saveChanges"
          @cancel="stopEditing"
        />
      </div>

      <div v-else class="detail-layout">
        <section class="card" aria-labelledby="details-heading">
          <h2 id="details-heading">Details</h2>
          <dl class="details">
            <div>
              <dt>Name</dt>
              <dd>{{ plant.name }}</dd>
            </div>
            <div>
              <dt>Variety</dt>
              <dd>{{ plant.variety || '–' }}</dd>
            </div>
            <div>
              <dt>Bed</dt>
              <dd>
                <NuxtLink :to="{ path: '/plants', query: { bed: plant.bed_id } }" class="link">
                  {{ plant.bed_name }}
                </NuxtLink>
              </dd>
            </div>
            <div>
              <dt>Spacing</dt>
              <dd>{{ plant.spacing_cm ? `${plant.spacing_cm} cm` : '–' }}</dd>
            </div>
            <div>
              <dt>Planted on</dt>
              <dd>{{ formatDate(plant.planted_on) }}</dd>
            </div>
            <div class="details__full">
              <dt>Notes</dt>
              <dd class="prewrap">{{ plant.notes || 'No notes yet.' }}</dd>
            </div>
          </dl>

          <div class="danger-zone">
            <AlertMessage v-if="deleteError">{{ deleteError }}</AlertMessage>
            <ConfirmButton
              label="Delete plant"
              :question="`Delete ${plant.name} and its ${plural(plant.harvest_count, 'harvest')}?`"
              confirm-label="Yes, delete plant"
              :pending="deleting"
              @confirm="deletePlant"
            />
          </div>
        </section>

        <section class="card" aria-labelledby="harvests-heading">
          <div class="section__head">
            <h2 id="harvests-heading">Harvests</h2>
            <span class="badge">{{ formatWeight(plant.harvest_grams) }} total</span>
          </div>
          <p v-if="averageHarvest !== null" class="muted">
            {{ plural(plant.harvest_count, 'harvest') }}, averaging {{ formatWeight(averageHarvest) }} each.
          </p>
          <AlertMessage v-if="harvestError">{{ harvestError }}</AlertMessage>

          <table v-if="plant.harvests.length" class="table">
            <caption class="visually-hidden">Harvests of {{ plant.name }}</caption>
            <thead>
              <tr>
                <th scope="col">Date</th>
                <th scope="col" class="num">Weight</th>
                <th scope="col">Notes</th>
                <th scope="col"><span class="visually-hidden">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="harvest in plant.harvests" :key="harvest.id">
                <td><time :datetime="harvest.harvested_on">{{ formatDate(harvest.harvested_on) }}</time></td>
                <td class="num">{{ formatWeight(harvest.weight_grams) }}</td>
                <td>{{ harvest.notes || '–' }}</td>
                <td class="actions">
                  <button
                    type="button"
                    class="btn btn--ghost btn--small"
                    :disabled="removingHarvestId === harvest.id"
                    @click="removeHarvest(harvest)"
                  >
                    Delete<span class="visually-hidden"> harvest from {{ formatDate(harvest.harvested_on) }}</span>
                  </button>
                </td>
              </tr>
            </tbody>
          </table>

          <EmptyState v-else title="No harvests yet" message="Log the first pick when it is ready.">
            <NuxtLink :to="{ path: '/harvests/new', query: { plant: plant.id } }" class="btn btn--ghost">
              Log harvest
            </NuxtLink>
          </EmptyState>
        </section>
      </div>
    </template>
  </div>
</template>
