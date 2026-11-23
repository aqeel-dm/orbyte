import { useCallback, useEffect, useState } from 'react'
import type { ActivityEvent } from '@shared/schemas/task'

export function useActivity(projectId: string, limit = 15) {
  const [events, setEvents] = useState<ActivityEvent[]>([])
  const refresh = useCallback(async () => {
    const res = await window.orbyte.activity.list(projectId, limit)
    if (res.ok) setEvents(res.data)
  }, [projectId, limit])
  useEffect(() => void refresh(), [refresh])
  useEffect(
    () => window.orbyte.onEvent((e) => { if (e.type !== 'text_delta' && e.type !== 'tool_activity' && e.projectId === projectId) void refresh() }),
    [projectId, refresh]
  )
  return events
}
