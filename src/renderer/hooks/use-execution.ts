import { useCallback, useEffect, useState } from 'react'
import type { ExecutionBundle } from '@shared/schemas/execution'

/** A task's execution runs, agent reports, evidence, Team Lead reviews, decisions and the completion gate. */
export function useExecution(projectId: string, taskId: string) {
  const [bundle, setBundle] = useState<ExecutionBundle | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const res = await window.orbyte.executions.get(projectId, taskId)
      if (res.ok) { setBundle(res.data); setError(null) } else setError(res.error.message)
    } catch {
      setError('Cannot reach the application backend.')
    }
  }, [projectId, taskId])

  useEffect(() => void refresh(), [refresh])
  useEffect(
    () => window.orbyte.onEvent((e) => {
      if ((e.type === 'executions_changed' && e.taskId === taskId) || (e.type === 'tasks_changed' && e.projectId === projectId)) void refresh()
    }),
    [projectId, taskId, refresh]
  )
  return { bundle, error, refresh }
}
