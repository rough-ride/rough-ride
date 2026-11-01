<script setup lang="ts">
const { $api } = useNuxtApp()
const doubleSubmit = useBug('double-submit')
const clearedForm = useBug('cleared-form')

const title = ref('')
const body = ref('')
const saving = ref(false)
const error = ref('')

async function save() {
  // Planted bug "double-submit": no in-flight guard, and the button stays enabled.
  if (saving.value && !doubleSubmit) return
  saving.value = true
  error.value = ''
  const payload = { title: title.value, body: body.value }

  if (clearedForm) {
    // Planted bug "cleared-form": the form is cleared before the save succeeds.
    title.value = ''
    body.value = ''
  }

  try {
    await $api('/notes', { method: 'POST', body: payload })
    await navigateTo('/notes')
  } catch (e: any) {
    error.value =
      e?.statusCode === 422
        ? 'Check the title: it must be 1 to 200 characters.'
        : 'Could not save the note. Try again.'
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <section>
    <h1>New note</h1>
    <form @submit.prevent="save">
      <label>
        Title
        <input v-model="title" name="title" required />
      </label>
      <label>
        Body
        <textarea v-model="body" name="body" rows="4" />
      </label>
      <p v-if="error" role="alert" class="error">{{ error }}</p>
      <button type="submit" :disabled="saving && !doubleSubmit">
        {{ saving ? 'Saving...' : 'Save' }}
      </button>
    </form>
    <p><NuxtLink to="/notes">Back to notes</NuxtLink></p>
  </section>
</template>
