import { MAX_DEPENDENCIES } from '@shared/schemas/task'
import type { TaskStatus } from '@shared/task-state'

export interface TaskIndexEntry {
  projectId: string
  status: TaskStatus
}

/** True if adding edges taskId -> each of dependsOn would create a cycle (taskId reachable from a dependency). */
export function wouldCreateCycle(taskId: string, dependsOn: string[], edges: Map<string, string[]>): boolean {
  const seen = new Set<string>()
  const stack = [...dependsOn]
  while (stack.length > 0) {
    const cur = stack.pop()!
    if (cur === taskId) return true
    if (seen.has(cur)) continue
    seen.add(cur)
    for (const next of edges.get(cur) ?? []) stack.push(next)
  }
  return false
}

/**
 * Validates the dependency list for a task (existing, or null for a task not yet created).
 * Returns an error message, or null when valid. Dependencies must exist in the same project,
 * must not be cancelled, must not repeat, and must not form a cycle.
 */
export function validateTaskDependencies(args: {
  projectId: string
  taskId: string | null
  dependsOn: string[]
  index: Map<string, TaskIndexEntry>
  edges: Map<string, string[]>
}): string | null {
  const { projectId, taskId, dependsOn, index, edges } = args
  if (dependsOn.length > MAX_DEPENDENCIES) return `A task can have at most ${MAX_DEPENDENCIES} dependencies.`
  if (new Set(dependsOn).size !== dependsOn.length) return 'Dependencies must not repeat.'
  for (const dep of dependsOn) {
    if (taskId !== null && dep === taskId) return 'A task cannot depend on itself.'
    const entry = index.get(dep)
    // Same message for "missing" and "other project" so ids from other projects are not confirmed to exist.
    if (!entry || entry.projectId !== projectId) return 'A dependency was not found in this project.'
    if (entry.status === 'cancelled') return 'A task cannot depend on a cancelled task.'
  }
  if (taskId !== null && wouldCreateCycle(taskId, dependsOn, edges)) return 'These dependencies would create a cycle.'
  return null
}

/** Orders keys so every key comes after the keys it depends on. Null when the graph has a cycle. */
export function topologicalOrder(keys: number[], deps: Map<number, number[]>): number[] | null {
  const order: number[] = []
  const state = new Map<number, 'visiting' | 'done'>()
  const visit = (k: number): boolean => {
    const s = state.get(k)
    if (s === 'done') return true
    if (s === 'visiting') return false
    state.set(k, 'visiting')
    for (const d of deps.get(k) ?? []) if (!visit(d)) return false
    state.set(k, 'done')
    order.push(k)
    return true
  }
  for (const k of keys) if (!visit(k)) return null
  return order
}
