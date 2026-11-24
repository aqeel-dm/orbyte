import { useCallback, useEffect, useState } from 'react'
import type { PlanBundle } from '@shared/schemas/plan'

/** A task's plan versions, Team Lead reviews, approval records and the gate's verdict. */
export function usePlan(projectId: string, taskId: string) {
  const [bundle, setBundle] = useState<PlanBundle | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const res = await window.orbyte.plans.get(projectId, taskId)
      if (res.ok) { setBundle(res.data); setError(null) } else setError(res.error.message)
    } catch {
      setError('Cannot reach the application backend.')
    }
  }, [projectId, taskId])

  useEffect(() => void refresh(), [refresh])
  useEffect(
    () => window.orbyte.onEvent((e) => {
      if ((e.type === 'plans_changed' && e.taskId === taskId) || (e.type === 'tasks_changed' && e.projectId === projectId)) void refresh()
    }),
    [projectId, taskId, refresh]
  )
  return { bundle, error, refresh }
}
