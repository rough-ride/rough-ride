export type PlantedBug = 'stuck-spinner' | 'double-submit' | 'cleared-form' | 'stale-search'

export function useBug(name: PlantedBug): boolean {
  const enabled = String(useRuntimeConfig().public.bugs)
    .split(',')
    .map((bug) => bug.trim())
  return enabled.includes('all') || enabled.includes(name)
}
