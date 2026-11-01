<script setup lang="ts">
type Note = { id: number; title: string; body: string; created_at: string }

const { $api } = useNuxtApp()
const token = useCookie<string | null>('token')
const staleSearch = useBug('stale-search')
const {
  data: notes,
  error: loadError,
  refresh,
} = await useAsyncData('notes', () => $api<Note[]>('/notes'))

const query = ref('')
const results = ref<Note[] | null>(null)
const searching = ref(false)
const searchError = ref('')
let latestSearch = 0
let debounce: ReturnType<typeof setTimeout> | undefined

function onSearchInput() {
  clearTimeout(debounce)
  debounce = setTimeout(runSearch, 250)
}

async function runSearch() {
  const q = query.value.trim()
  const id = ++latestSearch
  searchError.value = ''
  if (!q) {
    results.value = null
    searching.value = false
    return
  }
  searching.value = true
  try {
    const found = await $api<Note[]>('/notes', { query: { q } })
    // Ignore responses that arrive after a newer search started. Planted bug
    // "stale-search": no such guard, so an older answer can overwrite a newer one.
    if (staleSearch || id === latestSearch) results.value = found
  } catch {
    if (id === latestSearch) searchError.value = 'Search failed. Try again.'
  } finally {
    if (id === latestSearch) searching.value = false
  }
}

const shown = computed(() => results.value ?? notes.value ?? [])

async function signOut() {
  token.value = null
  await nextTick()
  await navigateTo('/login')
}
</script>

<template>
  <section>
    <h1>Notes</h1>
    <p><NuxtLink to="/notes/new">New note</NuxtLink></p>
    <label>
      Search
      <input v-model="query" type="search" name="q" @input="onSearchInput" />
    </label>
    <p v-if="searching" role="status">Searching...</p>
    <p v-if="searchError" role="alert" class="error">{{ searchError }}</p>
    <LazyLoadErrorPanel v-if="loadError" @retry="refresh()" />
    <template v-else>
      <ul>
        <li v-for="note in shown" :key="note.id">
          <strong>{{ note.title }}</strong>
          <span v-if="note.body"> {{ note.body }}</span>
        </li>
      </ul>
      <p v-if="shown.length === 0">No notes found.</p>
    </template>
    <button type="button" @click="signOut">Sign out</button>
  </section>
</template>
