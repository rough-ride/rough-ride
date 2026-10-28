<script setup lang="ts">
import type { Bed, BedInput, Sunlight } from '~/types/api'

useHead({ title: 'Beds' })

const api = useApiClient()
const { data: beds, error: loadError, refresh } = await useApiFetch<Bed[]>('/beds')

const sunlightOptions = Object.entries(SUNLIGHT_LABELS) as [Sunlight, string][]

function emptyBed(): BedInput {
  return { name: '', sunlight: 'full_sun', notes: '' }
}

const newBed = reactive<BedInput>(emptyBed())
const adding = ref(false)
const addError = ref<string | null>(null)

const editingId = ref<number | null>(null)
const editDraft = reactive<BedInput>(emptyBed())
const savingEdit = ref(false)
const editError = ref<string | null>(null)

const deletingId = ref<number | null>(null)
const listError = ref<string | null>(null)

const totalPlants = computed(() => beds.value?.reduce((sum, bed) => sum + bed.plant_count, 0) ?? 0)

async function addBed(): Promise<void> {
  addError.value = null
  if (!newBed.name.trim()) {
    addError.value = 'Give the bed a name.'
    return
  }
  adding.value = true
  try {
    await api('/beds', {
      method: 'POST',
      body: { name: newBed.name.trim(), sunlight: newBed.sunlight, notes: newBed.notes.trim() },
    })
    Object.assign(newBed, emptyBed())
    await refresh()
  } catch (err) {
    addError.value = apiErrorMessage(err, 'Could not add the bed.')
  } finally {
    adding.value = false
  }
}

function startEdit(bed: Bed): void {
  editingId.value = bed.id
  editError.value = null
  Object.assign(editDraft, { name: bed.name, sunlight: bed.sunlight, notes: bed.notes })
}

function cancelEdit(): void {
  editingId.value = null
  editError.value = null
}

async function saveEdit(bed: Bed): Promise<void> {
  editError.value = null
  if (!editDraft.name.trim()) {
    editError.value = 'Give the bed a name.'
    return
  }
  savingEdit.value = true
  try {
    await api(`/beds/${bed.id}`, {
      method: 'PUT',
      body: { name: editDraft.name.trim(), sunlight: editDraft.sunlight, notes: editDraft.notes.trim() },
    })
    editingId.value = null
    await refresh()
  } catch (err) {
    editError.value = apiErrorMessage(err, 'Could not save the bed.')
  } finally {
    savingEdit.value = false
  }
}

async function deleteBed(bed: Bed): Promise<void> {
  if (!window.confirm(`Delete the bed "${bed.name}"?`)) return
  deletingId.value = bed.id
  listError.value = null
  try {
    await api(`/beds/${bed.id}`, { method: 'DELETE' })
    await refresh()
  } catch (err) {
    listError.value = apiErrorMessage(err, 'Could not delete the bed.')
  } finally {
    deletingId.value = null
  }
}
</script>

<template>
  <div>
    <PageHeader
      title="Beds"
      :subtitle="beds ? `${plural(beds.length, 'bed')} holding ${plural(totalPlants, 'plant')}.` : undefined"
    />

    <div class="tasks-layout">
      <section class="card" aria-labelledby="add-bed-heading">
        <h2 id="add-bed-heading">Add a bed</h2>
        <form class="form" novalidate @submit.prevent="addBed">
          <AlertMessage v-if="addError">{{ addError }}</AlertMessage>
          <div class="field">
            <label for="bed-name">Name</label>
            <input
              id="bed-name"
              v-model="newBed.name"
              type="text"
              name="name"
              maxlength="60"
              placeholder="Raised bed 1"
              autocomplete="off"
              required
            >
          </div>
          <div class="field">
            <label for="bed-sunlight">Sunlight</label>
            <select id="bed-sunlight" v-model="newBed.sunlight" name="sunlight">
              <option v-for="[value, label] in sunlightOptions" :key="value" :value="value">
                {{ label }}
              </option>
            </select>
          </div>
          <div class="field">
            <label for="bed-notes">Notes</label>
            <textarea
              id="bed-notes"
              v-model="newBed.notes"
              name="notes"
              rows="3"
              maxlength="2000"
              placeholder="Soil, size, location"
            />
          </div>
          <div class="form__actions">
            <button type="submit" class="btn btn--primary" :disabled="adding">
              {{ adding ? 'Adding…' : 'Add bed' }}
            </button>
          </div>
        </form>
      </section>

      <section aria-labelledby="bed-list-heading">
        <h2 id="bed-list-heading" class="visually-hidden">All beds</h2>
        <AlertMessage v-if="loadError">
          {{ apiErrorMessage(loadError, 'Could not load beds.') }}
        </AlertMessage>
        <AlertMessage v-if="listError">{{ listError }}</AlertMessage>

        <ul v-if="beds && beds.length" class="bed-list">
          <li v-for="bed in beds" :key="bed.id" class="card bed">
            <form
              v-if="editingId === bed.id"
              class="form"
              novalidate
              @submit.prevent="saveEdit(bed)"
            >
              <AlertMessage v-if="editError">{{ editError }}</AlertMessage>
              <div class="field">
                <label :for="`bed-edit-name-${bed.id}`">Name</label>
                <input
                  :id="`bed-edit-name-${bed.id}`"
                  v-model="editDraft.name"
                  type="text"
                  maxlength="60"
                  required
                >
              </div>
              <div class="field">
                <label :for="`bed-edit-sun-${bed.id}`">Sunlight</label>
                <select :id="`bed-edit-sun-${bed.id}`" v-model="editDraft.sunlight">
                  <option v-for="[value, label] in sunlightOptions" :key="value" :value="value">
                    {{ label }}
                  </option>
                </select>
              </div>
              <div class="field">
                <label :for="`bed-edit-notes-${bed.id}`">Notes</label>
                <textarea
                  :id="`bed-edit-notes-${bed.id}`"
                  v-model="editDraft.notes"
                  rows="3"
                  maxlength="2000"
                />
              </div>
              <div class="form__actions">
                <button type="submit" class="btn btn--primary" :disabled="savingEdit">
                  {{ savingEdit ? 'Saving…' : 'Save bed' }}
                </button>
                <button type="button" class="btn btn--ghost" :disabled="savingEdit" @click="cancelEdit">
                  Cancel
                </button>
              </div>
            </form>

            <template v-else>
              <div class="bed__head">
                <h3 class="bed__name">{{ bed.name }}</h3>
                <span class="badge" :class="`badge--${bed.sunlight}`">{{ SUNLIGHT_LABELS[bed.sunlight] }}</span>
              </div>
              <p v-if="bed.notes" class="bed__notes prewrap">{{ bed.notes }}</p>
              <dl class="bed__stats">
                <div>
                  <dt>Plants</dt>
                  <dd>{{ bed.plant_count }}</dd>
                </div>
                <div>
                  <dt>Harvested</dt>
                  <dd>{{ formatWeight(bed.harvest_grams) }}</dd>
                </div>
              </dl>
              <div class="bed__actions">
                <NuxtLink
                  v-if="bed.plant_count"
                  :to="{ path: '/plants', query: { bed: bed.id } }"
                  class="btn btn--ghost btn--small"
                >
                  View plants<span class="visually-hidden"> in {{ bed.name }}</span>
                </NuxtLink>
                <NuxtLink :to="{ path: '/plants/new', query: { bed: bed.id } }" class="btn btn--ghost btn--small">
                  Add plant<span class="visually-hidden"> to {{ bed.name }}</span>
                </NuxtLink>
                <button type="button" class="btn btn--ghost btn--small" @click="startEdit(bed)">
                  Edit<span class="visually-hidden"> {{ bed.name }}</span>
                </button>
                <button
                  type="button"
                  class="btn btn--ghost btn--small"
                  :disabled="deletingId === bed.id || bed.plant_count > 0"
                  :title="bed.plant_count > 0 ? 'Move or delete its plants first' : undefined"
                  @click="deleteBed(bed)"
                >
                  Delete<span class="visually-hidden"> {{ bed.name }}</span>
                </button>
              </div>
            </template>
          </li>
        </ul>

        <EmptyState
          v-else-if="beds"
          title="No beds yet"
          message="Beds group your plants by where they grow. Add the first one with the form."
        />
      </section>
    </div>
  </div>
</template>
