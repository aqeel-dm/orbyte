import { FolderPlus, Loader2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { Project } from '@shared/schemas/project'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { useProjects } from '@/hooks/use-projects'
import type { TaskSummary } from '@shared/schemas/task'
import { ProjectCard } from '@/features/projects/project-card'
import { RegisterProjectDialog } from '@/features/projects/register-project-dialog'

// Only real data is shown. Metrics for features that don't exist yet display "—".
function Stat({ label, value, note }: { label: string; value: string | number; note?: string }) {
  return (
    <Card className="p-4">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      {note && <div className="mt-1 text-xs text-muted-foreground">{note}</div>}
    </Card>
  )
}

export function DashboardPage() {
  const [showArchived, setShowArchived] = useState(false)
  const { projects, loading, error, refresh } = useProjects(showArchived)
  const [open, setOpen] = useState(false)
  const [summary, setSummary] = useState<TaskSummary | null>(null)
  const [running, setRunning] = useState<number | null>(null)
  useEffect(() => {
    const load = () => {
      void window.orbyte.tasks.summary().then((r) => { if (r.ok) setSummary(r.data) })
      void window.orbyte.agents.summary().then((r) => { if (r.ok) setRunning(r.data.running) })
    }
    load()
    return window.orbyte.onEvent((e) => { if (e.type === 'tasks_changed' || e.type === 'project_updated' || e.type === 'agent_changed') load() })
  }, [])
  const [actionError, setActionError] = useState<string | null>(null)

  async function archive(p: Project) {
    if (!window.confirm(`Archive "${p.name}"? It is hidden but its history is kept, and your repository files are not touched.`)) return
    const res = await window.orbyte.projects.archive(p.id)
    setActionError(res.ok ? null : res.error.message)
    void refresh()
  }

  async function restore(p: Project) {
    const res = await window.orbyte.projects.restore(p.id)
    setActionError(res.ok ? null : res.error.message)
    void refresh()
  }

  return (
    <div className="mx-auto max-w-5xl px-8 pb-10 pt-12">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Dashboard</h1>
          <p className="text-sm text-muted-foreground">Your projects and the agents working on them.</p>
        </div>
        <Button onClick={() => setOpen(true)}><FolderPlus className="h-4 w-4" />Register project</Button>
      </header>

      <section className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Projects" value={projects.filter((p) => p.status === 'active').length} />
        <Stat label="Open tasks" value={summary?.open ?? '—'} note={summary ? `${summary.byStatus['in_progress'] ?? 0} in progress` : undefined} />
        <Stat label="Developer agents" value={running ?? '—'} note="running now" />
        <Stat label="Pending approvals" value={summary ? (summary.byStatus['awaiting_approval'] ?? 0) + (summary.byStatus['in_review'] ?? 0) : '—'} note="plans and results awaiting you" />
      </section>

      <div className="mb-3 mt-8 flex items-center justify-between">
        <h2 className="text-sm font-medium text-muted-foreground">Projects</h2>
        <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />Show archived
        </label>
      </div>
      {(error || actionError) && <p role="alert" className="mb-3 text-sm text-destructive">{error ?? actionError}</p>}
      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Loading…</div>
      ) : projects.length === 0 && !error ? (
        <Card className="flex flex-col items-center gap-3 border-dashed p-12 text-center">
          <p className="font-medium">No projects yet</p>
          <p className="max-w-sm text-sm text-muted-foreground">Register an existing repository to get started. Orbyte works directly in your project directory.</p>
          <Button onClick={() => setOpen(true)}><FolderPlus className="h-4 w-4" />Register your first project</Button>
        </Card>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">{projects.map((p) => <ProjectCard key={p.id} project={p} onArchive={archive} onRestore={restore} />)}</div>
      )}

      <RegisterProjectDialog open={open} onOpenChange={setOpen} onRegistered={refresh} />
    </div>
  )
}
