import { useState } from 'react'
import type { Task, TaskPriority } from '@shared/schemas/task'
import { CONTENT_EDITABLE } from '@shared/task-state'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { PRIORITY_LABEL } from './labels'

/** Create (task undefined) or edit a task. Dependencies are validated by the backend. */
export function TaskDialog({ projectId, task, others, open, onOpenChange }: {
  projectId: string
  task?: Task
  others: Task[]
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const contentEditable = !task || CONTENT_EDITABLE.includes(task.status)
  const [title, setTitle] = useState(task?.title ?? '')
  const [description, setDescription] = useState(task?.description ?? '')
  const [priority, setPriority] = useState<TaskPriority>(task?.priority ?? 'medium')
  const [deps, setDeps] = useState<string[]>((task?.dependsOnTaskIds ?? []).filter((id) => others.some((o) => o.id === id && o.status !== 'cancelled')))
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const candidates = others.filter((o) => o.id !== task?.id && o.status !== 'cancelled')

  async function save() {
    setBusy(true); setError(null)
    const res = task
      ? await window.orbyte.tasks.update({ projectId, taskId: task.id, patch: contentEditable ? { title, description, priority, dependsOnTaskIds: deps } : { priority } })
      : await window.orbyte.tasks.create({ projectId, title, description, priority, dependsOnTaskIds: deps })
    setBusy(false)
    if (!res.ok) return setError(res.error.message)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle className="text-lg font-semibold">{task ? 'Edit task' : 'New task'}</DialogTitle>
        <DialogDescription className="mt-1 text-sm text-muted-foreground">
          {task && !contentEditable ? 'This task is in progress, so only its priority can change.' : 'Tasks you create here start in the backlog.'}
        </DialogDescription>
        <div className="mt-4 space-y-4">
          <label className="block text-sm font-medium">Title
            <Input className="mt-1" value={title} maxLength={120} disabled={!contentEditable} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <label className="block text-sm font-medium">Description
            <textarea className="mt-1 min-h-[5rem] w-full rounded-md border border-border bg-card px-3 py-2 text-sm disabled:opacity-50" value={description} maxLength={4000} disabled={!contentEditable} onChange={(e) => setDescription(e.target.value)} />
          </label>
          <label className="block text-sm font-medium">Priority
            <select className="mt-1 h-9 w-full rounded-md border border-border bg-card px-2 text-sm" value={priority} onChange={(e) => setPriority(e.target.value as TaskPriority)}>
              {(Object.keys(PRIORITY_LABEL) as TaskPriority[]).map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}
            </select>
          </label>
          {contentEditable && candidates.length > 0 && (
            <fieldset>
              <legend className="text-sm font-medium">Depends on</legend>
              <div className="mt-1 max-h-32 space-y-1 overflow-auto rounded-md border border-border p-2">
                {candidates.map((c) => (
                  <label key={c.id} className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={deps.includes(c.id)} onChange={(e) => setDeps((d) => (e.target.checked ? [...d, c.id] : d.filter((x) => x !== c.id)))} />
                    <span className="truncate">{c.title}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          )}
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        </div>
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={save} disabled={busy || !title.trim()}>{busy ? 'Saving…' : task ? 'Save' : 'Create task'}</Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
