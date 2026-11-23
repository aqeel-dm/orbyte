import { useCallback, useEffect, useState } from 'react'
import type { Task, TaskProposal } from '@shared/schemas/task'

/** Tasks and pending proposals for one project; refreshes on pushed change events. */
export function useTasks(projectId: string) {
  const [tasks, setTasks] = useState<Task[]>([])
  const [proposals, setProposals] = useState<TaskProposal[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const [t, p] = await Promise.all([window.orbyte.tasks.list(projectId), window.orbyte.proposals.list(projectId)])
      if (t.ok) setTasks(t.data)
      if (p.ok) setProposals(p.data)
      setError(t.ok ? (p.ok ? null : p.error.message) : t.error.message)
    } catch {
      setError('Cannot reach the application backend.')
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => void refresh(), [refresh])
  useEffect(
    () => window.orbyte.onEvent((e) => { if ((e.type === 'tasks_changed' || e.type === 'proposals_changed') && e.projectId === projectId) void refresh() }),
    [projectId, refresh]
  )
  return { tasks, proposals, pending: proposals.filter((p) => p.status === 'pending'), loading, error, refresh }
}
