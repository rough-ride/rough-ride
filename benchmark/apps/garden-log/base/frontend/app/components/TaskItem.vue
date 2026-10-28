<script setup lang="ts">
import type { Task } from '~/types/api'

const props = defineProps<{
  task: Task
  busy?: boolean
  compact?: boolean
}>()

const emit = defineEmits<{
  toggle: [task: Task]
  remove: [task: Task]
}>()

const checkboxId = useId()

const dueText = computed(() =>
  props.task.done ? `Done · was due ${formatDate(props.task.due_on)}` : dueLabel(props.task.due_on),
)
</script>

<template>
  <li class="task" :class="{ 'task--done': task.done, 'task--overdue': task.overdue }">
    <input
      :id="checkboxId"
      type="checkbox"
      class="task__check"
      :checked="task.done"
      :disabled="busy"
      @change="emit('toggle', task)"
    >
    <label :for="checkboxId" class="task__body">
      <span class="task__title">{{ task.title }}</span>
      <span class="task__due">
        <time :datetime="task.due_on">{{ formatDate(task.due_on) }}</time>
        <span aria-hidden="true"> · </span>
        <span>{{ dueText }}</span>
      </span>
    </label>
    <button
      v-if="!compact"
      type="button"
      class="btn btn--ghost btn--small task__remove"
      :disabled="busy"
      @click="emit('remove', task)"
    >
      Delete<span class="visually-hidden"> task {{ task.title }}</span>
    </button>
  </li>
</template>
