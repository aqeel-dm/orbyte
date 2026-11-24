import { useCallback, useEffect, useState } from 'react'
import type { DeveloperAgent } from '@shared/schemas/agent'

/** Developer agents for one project; refreshes on pushed change events. */
export function useAgents(projectId: string) {
  const [agents, setAgents] = useState<DeveloperAgent[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const res = await window.orbyte.agents.list(projectId)
      if (res.ok) { setAgents(res.data); setError(null) } else setError(res.error.message)
    } catch {
      setError('Cannot reach the application backend.')
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => void refresh(), [refresh])
  useEffect(
    () => window.orbyte.onEvent((e) => { if (e.type === 'agent_changed' && e.projectId === projectId) void refresh() }),
    [projectId, refresh]
  )
  return { agents, running: agents.filter((a) => a.status === 'running' || a.status === 'starting').length, loading, error, refresh }
}
