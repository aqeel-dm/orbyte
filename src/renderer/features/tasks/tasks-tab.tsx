import { Plus } from 'lucide-react'
import { useState } from 'react'
import { PRIORITY_ORDER, type Task } from '@shared/schemas/task'
import { CONTENT_EDITABLE, isOpen, userTransitionsFrom, type TaskStatus } from '@shared/task-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { useTasks } from '@/hooks/use-tasks'
import { PRIORITY_LABEL, STATUS_LABEL, STATUS_ORDER, moveLabel } from './labels'
import { ProposalCard } from './proposal-card'
import { TaskDialog } from './task-dialog'

export function TasksTab({ projectId, archived, onAgentStarted }: { projectId: string; archived: boolean; onAgentStarted: (agentId: string) => void }) {
  const { tasks, pending, loading, error, refresh } = useTasks(projectId)
  const [dialog, setDialog] = useState<{ task?: Task } | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [showClosed, setShowClosed] = useState(false)
  const titleOf = (id: string) => tasks.find((t) => t.id === id)?.title ?? 'a removed task'

  async function startAgent(task: Task) {
    setActionError(null)
    const res = await window.orbyte.agents.start(projectId, task.id)
    if (!res.ok) return setActionError(res.error.message)
    onAgentStarted(res.data.id)
  }

  async function move(task: Task, to: TaskStatus) {
    setActionError(null)
    const res = await window.orbyte.tasks.transition(projectId, task.id, to)
    if (!res.ok) setActionError(res.error.message)
  }

  const visible = tasks.filter((t) => showClosed || isOpen(t.status))
  const groups = STATUS_ORDER.map((s) => ({ status: s, items: visible.filter((t) => t.status === s).sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]) })).filter((g) => g.items.length > 0)
  const closedCount = tasks.filter((t) => !isOpen(t.status)).length

  return (
    <div className="space-y-4 overflow-auto pb-8">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">Tasks you add are yours. The Team Lead can only propose tasks; they appear here only after you approve them.</p>
        <Button size="sm" disabled={archived} onClick={() => setDialog({})}><Plus className="h-4 w-4" />New task</Button>
      </div>

      {pending.map((p) => <ProposalCard key={p.id} proposal={p} tasks={tasks} onDone={() => void refresh()} />)}
      {(error || actionError) && <p role="alert" className="text-sm text-destructive">{error ?? actionError}</p>}

      {loading ? <p className="text-sm text-muted-foreground">Loading…</p> : groups.length === 0 && pending.length === 0 ? (
        <Card className="border-dashed p-10 text-center text-sm text-muted-foreground">No tasks yet. Add one, or ask the Team Lead to break a requirement down in the Team Lead tab.</Card>
      ) : groups.map((g) => (
        <section key={g.status}>
          <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">{STATUS_LABEL[g.status]} ({g.items.length})</h3>
          <ul className="space-y-2">
            {g.items.map((t) => (
              <li key={t.id}>
                <Card className="p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="break-words font-medium">{t.title}</p>
                      {t.description && <p className="mt-0.5 line-clamp-2 whitespace-pre-wrap break-words text-sm text-muted-foreground">{t.description}</p>}
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <Badge variant={t.priority === 'urgent' ? 'destructive' : t.priority === 'high' ? 'warning' : 'default'}>{PRIORITY_LABEL[t.priority]}</Badge>
                        {t.source === 'team_lead' && <Badge>From Team Lead</Badge>}
                        {t.dependsOnTaskIds.length > 0 && <span className="text-xs text-muted-foreground">Depends on: {t.dependsOnTaskIds.map(titleOf).join(', ')}</span>}
                      </div>
                    </div>
                    <div className="flex shrink-0 flex-wrap justify-end gap-1">
                      {!archived && (isOpen(t.status) || CONTENT_EDITABLE.includes(t.status)) && <Button size="sm" variant="ghost" onClick={() => setDialog({ task: t })}>Edit</Button>}
                      {!archived && t.status === 'ready' && <Button size="sm" onClick={() => startAgent(t)}>Start agent</Button>}
                      {!archived && userTransitionsFrom(t.status).map((to) => <Button key={to} size="sm" variant="outline" onClick={() => move(t, to)}>{moveLabel(t.status, to)}</Button>)}
                    </div>
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        </section>
      ))}
      {closedCount > 0 && <Button variant="ghost" size="sm" onClick={() => setShowClosed((v) => !v)}>{showClosed ? 'Hide' : 'Show'} closed tasks ({closedCount})</Button>}

      {dialog && <TaskDialog key={dialog.task?.id ?? 'new'} projectId={projectId} task={dialog.task} others={tasks} open onOpenChange={(o) => { if (!o) setDialog(null) }} />}
    </div>
  )
}
