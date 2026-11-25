import { Card } from '@/components/ui/card'
import { describeEvent } from '@/features/tasks/labels'
import { useRecentActivity } from '@/hooks/use-recent-activity'

/** Dashboard timeline across all active projects. */
export function RecentActivity() {
  const events = useRecentActivity()
  return (
    <section className="mt-8">
      <h2 className="mb-3 text-sm font-medium text-muted-foreground">Recent activity</h2>
      {events.length === 0 ? (
        <Card className="border-dashed p-6 text-center text-sm text-muted-foreground">Nothing has happened yet. Activity from your projects appears here.</Card>
      ) : (
        <Card className="p-4">
          <ul className="space-y-1.5 text-sm">
            {events.map((e) => (
              <li key={e.id} className="flex justify-between gap-3">
                <span className="min-w-0 break-words">
                  {e.projectName && <span className="mr-2 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">{e.projectName}</span>}
                  {describeEvent(e.type, e.payload)}
                </span>
                <time className="shrink-0 text-xs text-muted-foreground" dateTime={new Date(e.createdAt).toISOString()}>{new Date(e.createdAt).toLocaleString()}</time>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </section>
  )
}
