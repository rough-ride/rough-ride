<script setup lang="ts">
import type { Task } from '~/types/api'

useHead({ title: 'Tasks' })

type TaskState = 'open' | 'done' | 'all'

const api = useApiClient()
const state = ref<TaskState>('open')
const { data: tasks, error: loadError, refresh, status } = await useApiFetch<Task[]>('/tasks', {
  query: { state },
})

const tabs: { value: TaskState; label: string }[] = [
  { value: 'open', label: 'Open' },
  { value: 'done', label: 'Done' },
  { value: 'all', label: 'All' },
]

const title = ref('')
const dueOn = ref(todayIso())
const adding = ref(false)
const formError = ref<string | null>(null)
const actionError = ref<string | null>(null)
const busyTaskId = ref<number | null>(null)
const titleInput = ref<HTMLInputElement | null>(null)

const overdueCount = computed(() => tasks.value?.filter((t) => t.overdue).length ?? 0)

async function addTask(): Promise<void> {
  formError.value = null
  if (!title.value.trim()) {
    formError.value = 'Give the task a title.'
    return
  }
  if (!dueOn.value) {
    formError.value = 'Choose a due date.'
    return
  }
  adding.value = true
  try {
    await api('/tasks', { method: 'POST', body: { title: title.value.trim(), due_on: dueOn.value } })
    title.value = ''
    if (state.value === 'done') state.value = 'open'
    else await refresh()
    titleInput.value?.focus()
  } catch (err) {
    formError.value = apiErrorMessage(err, 'Could not add the task.')
  } finally {
    adding.value = false
  }
}

async function toggleTask(task: Task): Promise<void> {
  busyTaskId.value = task.id
  actionError.value = null
  try {
    await api(`/tasks/${task.id}`, { method: 'PATCH', body: { done: !task.done } })
    await refresh()
  } catch (err) {
    actionError.value = apiErrorMessage(err, 'Could not update the task.')
  } finally {
    busyTaskId.value = null
  }
}

async function removeTask(task: Task): Promise<void> {
  if (!window.confirm(`Delete the task "${task.title}"?`)) return
  busyTaskId.value = task.id
  actionError.value = null
  try {
    await api(`/tasks/${task.id}`, { method: 'DELETE' })
    await refresh()
  } catch (err) {
    actionError.value = apiErrorMessage(err, 'Could not delete the task.')
  } finally {
    busyTaskId.value = null
  }
}
</script>

<template>
  <div>
    <PageHeader title="Tasks" subtitle="Jobs to do in the garden. Tick one off when it is done." />

    <div class="tasks-layout">
      <section class="card" aria-labelledby="add-task-heading">
        <h2 id="add-task-heading">Add a task</h2>
        <form class="form" novalidate @submit.prevent="addTask">
          <AlertMessage v-if="formError">{{ formError }}</AlertMessage>
          <div class="field">
            <label for="task-title">Title</label>
            <input
              id="task-title"
              ref="titleInput"
              v-model="title"
              type="text"
              name="title"
              maxlength="120"
              placeholder="Water the seedlings"
              autocomplete="off"
              required
            >
          </div>
          <div class="field">
            <label for="task-due">Due date</label>
            <input id="task-due" v-model="dueOn" type="date" name="due_on" required>
          </div>
          <div class="form__actions">
            <button type="submit" class="btn btn--primary" :disabled="adding">
              {{ adding ? 'Adding…' : 'Add task' }}
            </button>
          </div>
        </form>
      </section>

      <section class="card" aria-labelledby="task-list-heading">
        <div class="section__head">
          <h2 id="task-list-heading">Task list</h2>
          <span v-if="state === 'open' && overdueCount" class="badge badge--warn">
            {{ overdueCount }} overdue
          </span>
        </div>

        <div class="tabs" role="group" aria-label="Show tasks">
          <button
            v-for="tab in tabs"
            :key="tab.value"
            type="button"
            class="tabs__tab"
            :class="{ 'tabs__tab--active': state === tab.value }"
            :aria-pressed="state === tab.value"
            @click="state = tab.value"
          >
            {{ tab.label }}
          </button>
        </div>

        <AlertMessage v-if="loadError">
          {{ apiErrorMessage(loadError, 'Could not load tasks.') }}
        </AlertMessage>
        <AlertMessage v-if="actionError">{{ actionError }}</AlertMessage>

        <ul v-if="tasks && tasks.length" class="task-list" :aria-busy="status === 'pending'">
          <TaskItem
            v-for="task in tasks"
            :key="task.id"
            :task="task"
            :busy="busyTaskId === task.id"
            @toggle="toggleTask"
            @remove="removeTask"
          />
        </ul>
        <EmptyState
          v-else-if="tasks"
          :title="state === 'done' ? 'Nothing finished yet' : state === 'open' ? 'All caught up' : 'No tasks yet'"
          :message="state === 'done' ? 'Completed tasks will appear here.' : 'Add a task with the form.'"
        />
      </section>
    </div>
  </div>
</template>
