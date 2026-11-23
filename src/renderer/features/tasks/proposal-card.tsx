import { Sparkles } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { ProposalItem, Task, TaskPriority, TaskProposal } from '@shared/schemas/task'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { PRIORITY_LABEL } from './labels'

/**
 * Review of a Team Lead proposal. Nothing exists until the user clicks Create: they can untick
 * tasks and edit the rest first. The backend re-validates everything on approval.
 */
export function ProposalCard({ proposal, tasks, onDone }: { proposal: TaskProposal; tasks: Task[]; onDone: () => void }) {
  const existingTitle = (id: string) => tasks.find((t) => t.id === id)?.title ?? 'an unknown task'
  const [items, setItems] = useState<ProposalItem[]>(proposal.items)
  const [selected, setSelected] = useState<Set<number>>(() => new Set(proposal.items.map((i) => i.key)))
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const titleOf = (key: number) => items.find((i) => i.key === key)?.title ?? `#${key}`
  const missing = useMemo(
    () => items.filter((i) => selected.has(i.key)).flatMap((i) => i.dependsOnKeys.filter((k) => !selected.has(k)).map((k) => `"${i.title}" depends on "${titleOf(k)}"`)),
    [items, selected]
  )
  const chosen = items.filter((i) => selected.has(i.key))
  const edit = (key: number, patch: Partial<ProposalItem>) => setItems((all) => all.map((i) => (i.key === key ? { ...i, ...patch } : i)))

  async function approve() {
    setBusy(true); setError(null)
    const res = await window.orbyte.proposals.approve(proposal.projectId, proposal.id, chosen)
    setBusy(false)
    if (!res.ok) return setError(res.error.message)
    onDone()
  }
  async function dismiss() {
    setBusy(true); setError(null)
    const res = await window.orbyte.proposals.dismiss(proposal.projectId, proposal.id)
    setBusy(false)
    if (!res.ok) return setError(res.error.message)
    onDone()
  }

  return (
    <Card className="border-primary/40 p-4">
      <div className="flex items-center gap-2"><Sparkles className="h-4 w-4 text-primary" /><h3 className="font-semibold">Team Lead proposal</h3><Badge variant="warning">Not created yet</Badge></div>
      {proposal.summary && <p className="mt-1 whitespace-pre-wrap break-words text-sm text-muted-foreground">{proposal.summary}</p>}
      <p className="mt-1 text-xs text-muted-foreground">Untick tasks you don't want and edit the rest. Nothing is added to your backlog until you click Create.</p>
      <ul className="mt-3 space-y-3">
        {items.map((i) => (
          <li key={i.key} className="rounded-md border border-border p-3">
            <div className="flex items-start gap-2">
              <input type="checkbox" className="mt-2" aria-label={`Include ${i.title}`} checked={selected.has(i.key)} onChange={(e) => setSelected((s) => { const n = new Set(s); if (e.target.checked) n.add(i.key); else n.delete(i.key); return n })} />
              <div className="min-w-0 flex-1 space-y-2">
                <input className="h-8 w-full rounded-md border border-border bg-card px-2 text-sm" value={i.title} maxLength={120} disabled={!selected.has(i.key)} onChange={(e) => edit(i.key, { title: e.target.value })} aria-label="Task title" />
                <textarea className="min-h-[3.5rem] w-full rounded-md border border-border bg-card px-2 py-1 text-sm" value={i.description} maxLength={4000} disabled={!selected.has(i.key)} onChange={(e) => edit(i.key, { description: e.target.value })} aria-label="Task description" />
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <select className="h-7 rounded-md border border-border bg-card px-1 text-xs" value={i.priority} disabled={!selected.has(i.key)} onChange={(e) => edit(i.key, { priority: e.target.value as TaskPriority })} aria-label="Priority">
                    {(Object.keys(PRIORITY_LABEL) as TaskPriority[]).map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}
                  </select>
                  {i.dependsOnKeys.length > 0 && <span>Depends on: {i.dependsOnKeys.map(titleOf).join(', ')}</span>}
                  {i.dependsOnTaskIds.length > 0 && <span>Also depends on existing: {i.dependsOnTaskIds.map(existingTitle).join(', ')}</span>}
                </div>
              </div>
            </div>
          </li>
        ))}
      </ul>
      {missing.length > 0 && <p role="alert" className="mt-2 text-sm text-warning">Include the tasks they depend on, or untick the dependents: {missing.join('; ')}.</p>}
      {error && <p role="alert" className="mt-2 text-sm text-destructive">{error}</p>}
      <div className="mt-3 flex gap-2">
        <Button disabled={busy || chosen.length === 0 || missing.length > 0 || chosen.some((i) => !i.title.trim())} onClick={approve}>Create {chosen.length} task{chosen.length === 1 ? '' : 's'}</Button>
        <Button variant="outline" disabled={busy} onClick={dismiss}>Dismiss</Button>
      </div>
    </Card>
  )
}
