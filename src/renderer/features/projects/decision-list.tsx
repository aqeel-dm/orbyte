import { Link } from 'react-router-dom'
import { Card } from '@/components/ui/card'
import { useDecisions } from '@/hooks/use-decisions'

const KIND = {
  proposal: { label: 'Proposed tasks', hint: 'Approve or dismiss' },
  plan: { label: 'Plan', hint: 'Approve or reject' },
  result: { label: 'Result', hint: 'Accept or request changes' }
} as const

/** Everything only you can decide. With `projectId` it lists that project; without, all active projects. */
export function DecisionList({ projectId }: { projectId?: string }) {
  const items = useDecisions(projectId)
  if (!items || items.length === 0) return null
  return (
    <Card className="border-warning/40 p-4">
      <h2 className="font-semibold">Waiting for you <span className="text-sm font-normal text-muted-foreground">({items.length})</span></h2>
      <ul className="mt-2 divide-y divide-border text-sm">
        {items.map((d, i) => (
          <li key={`${i}-${d.kind}-${d.taskId ?? d.projectId}`}>
            <Link to={`/projects/${d.projectId}?tab=tasks`} className="flex items-center justify-between gap-3 rounded py-2 hover:bg-muted/40">
              <span className="min-w-0">
                <span className="mr-2 rounded bg-muted px-1.5 py-0.5 text-xs">{KIND[d.kind].label}</span>
                {!projectId && <span className="mr-2 text-xs text-muted-foreground">{d.projectName}</span>}
                <span className="break-words">{d.title}</span>
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">{KIND[d.kind].hint} · waiting since {new Date(d.since).toLocaleString()}</span>
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  )
}
