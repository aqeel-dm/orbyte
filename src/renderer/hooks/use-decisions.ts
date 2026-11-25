import { useCallback, useEffect, useState } from 'react'
import type { DecisionItem } from '@shared/schemas/task'

/** What is waiting for the user's decision (all projects, or one). Refreshes when any related state changes. */
export function useDecisions(projectId?: string) {
  const [items, setItems] = useState<DecisionItem[] | null>(null)
  const refresh = useCallback(async () => {
    const res = await window.orbyte.decisions.list(projectId)
    if (res.ok) setItems(res.data)
  }, [projectId])
  useEffect(() => void refresh(), [refresh])
  useEffect(
    () =>
      window.orbyte.onEvent((e) => {
        if (['tasks_changed', 'proposals_changed', 'plans_changed', 'executions_changed', 'project_updated', 'agent_changed'].includes(e.type)) void refresh()
      }),
    [refresh]
  )
  return items
}
