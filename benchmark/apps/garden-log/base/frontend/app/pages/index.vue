<script setup lang="ts">
import type { Summary, Task } from '~/types/api'

useHead({ title: 'Dashboard' })

const user = useCurrentUser()
const api = useApiClient()

const [summaryResult, tasksResult] = await Promise.all([
  useApiFetch<Summary>('/dashboard/summary'),
  useApiFetch<Task[]>('/tasks/upcoming', { query: { limit: 5 } }),
])

const { data: summary, error: summaryError, refresh: refreshSummary } = summaryResult
const { data: tasks, error: tasksError, refresh: refreshTasks } = tasksResult

const busyTaskId = ref<number | null>(null)
const actionError = ref<string | null>(null)

const greeting = computed(() => {
  const name = user.value?.display_name.split(' ')[0]
  return name ? `Welcome back, ${name}. Here is how the garden is doing.` : 'Here is how the garden is doing.'
})

const taskHint = computed(() => {
  if (!summary.value) return undefined
  const overdue = summary.value.overdue_task_count
  return overdue > 0 ? `${overdue} overdue` : 'Nothing overdue'
})

async function completeTask(task: Task): Promise<void> {
  busyTaskId.value = task.id
  actionError.value = null
  try {
    await api(`/tasks/${task.id}`, { method: 'PATCH', body: { done: !task.done } })
    await Promise.all([refreshTasks(), refreshSummary()])
  } catch (err) {
    actionError.value = apiErrorMessage(err)
  } finally {
    busyTaskId.value = null
  }
}
</script>

<template>
  <div>
    <PageHeader title="Dashboard" :subtitle="greeting">
      <template #actions>
        <NuxtLink to="/plants/new" class="btn btn--ghost">Add plant</NuxtLink>
        <NuxtLink to="/harvests/new" class="btn btn--primary">Log harvest</NuxtLink>
      </template>
    </PageHeader>

    <section aria-labelledby="summary-heading" class="section">
      <h2 id="summary-heading" class="visually-hidden">Summary</h2>
      <AlertMessage v-if="summaryError">
        {{ apiErrorMessage(summaryError, 'Could not load the summary.') }}
      </AlertMessage>
      <div v-else-if="summary" class="stats">
        <StatCard
          label="Plants"
          :value="summary.plant_count"
          :hint="`In ${plural(summary.bed_count, 'bed')}`"
          to="/plants"
        />
        <StatCard
          :label="`Harvested in ${summary.year}`"
          :value="formatWeight(summary.harvest_grams_year)"
          :hint="plural(summary.harvest_count_year, 'harvest')"
        />
        <StatCard
          label="Top plant this year"
          :value="summary.top_plant ?? 'None yet'"
          hint="By harvest weight"
        />
        <StatCard
          label="Open tasks"
          :value="summary.open_task_count"
          :hint="taskHint"
          to="/tasks"
        />
      </div>
    </section>

    <section aria-labelledby="upcoming-heading" class="section card">
      <div class="section__head">
        <h2 id="upcoming-heading">Upcoming tasks</h2>
        <NuxtLink to="/tasks" class="link">All tasks</NuxtLink>
      </div>
      <AlertMessage v-if="tasksError">
        {{ apiErrorMessage(tasksError, 'Could not load upcoming tasks.') }}
      </AlertMessage>
      <AlertMessage v-if="actionError">{{ actionError }}</AlertMessage>
      <ul v-if="tasks && tasks.length" class="task-list">
        <TaskItem
          v-for="task in tasks"
          :key="task.id"
          :task="task"
          :busy="busyTaskId === task.id"
          compact
          @toggle="completeTask"
        />
      </ul>
      <EmptyState
        v-else-if="tasks"
        title="No upcoming tasks"
        message="Add sowing, watering or pruning jobs to keep track of them here."
      >
        <NuxtLink to="/tasks" class="btn btn--ghost">Add a task</NuxtLink>
      </EmptyState>
    </section>

    <section v-if="summary && summary.bed_count === 0" class="section">
      <AlertMessage tone="info">
        Start by creating a garden bed, then add the plants growing in it.
        <NuxtLink to="/beds" class="link">Set up beds</NuxtLink>
      </AlertMessage>
    </section>
  </div>
</template>
