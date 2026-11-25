import { useCallback, useEffect, useState } from 'react'
import type { RecentActivityEvent } from '@shared/schemas/task'

/** The newest events across projects; refreshes when any project's state changes. */
export function useRecentActivity(limit = 12) {
  const [events, setEvents] = useState<RecentActivityEvent[]>([])
  const refresh = useCallback(async () => {
    const res = await window.orbyte.activity.listRecent(limit)
    if (res.ok) setEvents(res.data)
  }, [limit])
  useEffect(() => void refresh(), [refresh])
  useEffect(
    () => window.orbyte.onEvent((e) => { if (e.type !== 'text_delta' && e.type !== 'tool_activity') void refresh() }),
    [refresh]
  )
  return events
}
