export type Sunlight = 'full_sun' | 'partial_shade' | 'shade'

export interface User {
  id: number
  email: string
  display_name: string
}

export interface SessionResponse {
  user: User | null
}

export interface Bed {
  id: number
  name: string
  sunlight: Sunlight
  notes: string
  plant_count: number
  harvest_grams: number
}

export interface BedInput {
  name: string
  sunlight: Sunlight
  notes: string
}

export interface Plant {
  id: number
  name: string
  variety: string
  bed_id: number
  bed_name: string
  spacing_cm: number | null
  planted_on: string | null
  notes: string
  harvest_count: number
  harvest_grams: number
  created_at: string
  updated_at: string
}

export interface PlantInput {
  name: string
  variety: string
  bed_id: number | null
  spacing_cm: number | null
  planted_on: string | null
  notes: string
}

export interface Harvest {
  id: number
  plant_id: number
  plant_name: string
  weight_grams: number
  harvested_on: string
  notes: string
}

export interface PlantDetail extends Plant {
  harvests: Harvest[]
}

export interface Task {
  id: number
  title: string
  due_on: string
  done: boolean
  done_at: string | null
  overdue: boolean
}

export interface Summary {
  year: number
  plant_count: number
  bed_count: number
  harvest_count_year: number
  harvest_grams_year: number
  open_task_count: number
  overdue_task_count: number
  top_plant: string | null
}
