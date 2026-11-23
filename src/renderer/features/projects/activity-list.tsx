import { Card } from '@/components/ui/card'
import { describeEvent } from '@/features/tasks/labels'
import { useActivity } from '@/hooks/use-activity'

export function ActivityList({ projectId }: { projectId: string }) {
  const events = useActivity(projectId)
  if (events.length === 0) return null
  return (
    <Card className="p-4">
      <h2 className="font-semibold">Recent activity</h2>
      <ul className="mt-2 space-y-1.5 text-sm">
        {events.map((e) => (
          <li key={e.id} className="flex justify-between gap-3">
            <span className="min-w-0 break-words">{describeEvent(e.type, e.payload)}</span>
            <time className="shrink-0 text-xs text-muted-foreground" dateTime={new Date(e.createdAt).toISOString()}>{new Date(e.createdAt).toLocaleString()}</time>
          </li>
        ))}
      </ul>
    </Card>
  )
}
