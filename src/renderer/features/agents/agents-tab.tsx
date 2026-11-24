import { GitBranch, Square, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { DeveloperAgent } from '@shared/schemas/agent'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { useAgents } from '@/hooks/use-agents'
import { useTasks } from '@/hooks/use-tasks'
import { cn } from '@/lib/utils'
import { TerminalView } from './terminal-view'

const STATUS_LABEL: Record<DeveloperAgent['status'], string> = {
  starting: 'Starting', running: 'Running', exited: 'Exited', failed: 'Failed', stopped: 'Stopped', interrupted: 'Interrupted (app closed)'
}
const variant = (s: DeveloperAgent['status']) => (s === 'running' ? 'success' : s === 'failed' ? 'destructive' : s === 'interrupted' ? 'warning' : 'default')

export function AgentsTab({ projectId, selectedId, onSelect }: { projectId: string; selectedId: string | null; onSelect: (id: string | null) => void }) {
  const { agents, loading, error, refresh } = useAgents(projectId)
  const { tasks } = useTasks(projectId)
  const [actionError, setActionError] = useState<string | null>(null)
  const selected = agents.find((a) => a.id === selectedId) ?? null
  const taskTitle = (id: string) => tasks.find((t) => t.id === id)?.title ?? 'Unknown task'

  // Select the newest agent when nothing is selected.
  useEffect(() => { if (!selectedId && agents[0]) onSelect(agents[0].id) }, [agents, selectedId, onSelect])

  async function stop(a: DeveloperAgent) {
    setActionError(null)
    const res = await window.orbyte.agents.stop(projectId, a.id)
    if (!res.ok) setActionError(res.error.message)
  }

  async function discard(a: DeveloperAgent) {
    setActionError(null)
    if (!window.confirm(`Remove the worktree for ${a.name}? The branch ${a.branch} is kept if it has any commits.`)) return
    let res = await window.orbyte.agents.discard(projectId, a.id)
    if (!res.ok && res.error.code === 'WORKTREE_DIRTY') {
      if (!window.confirm(`${res.error.message}\n\nDelete the uncommitted changes?`)) return
      res = await window.orbyte.agents.discard(projectId, a.id, true)
    }
    if (!res.ok) setActionError(res.error.message)
    void refresh()
  }

  if (loading) return <p className="text-sm text-muted-foreground">Loading…</p>
  if (agents.length === 0) {
    return (
      <Card className="border-dashed p-10 text-center text-sm text-muted-foreground">
        {error ?? 'No developer agents yet. Mark a task Ready in the Tasks tab, then choose Start agent. Each agent is a real Claude Code session in its own git worktree.'}
      </Card>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      {(error || actionError) && <p role="alert" className="text-sm text-destructive">{error ?? actionError}</p>}
      <div className="grid max-h-48 shrink-0 gap-2 overflow-auto">
        {agents.map((a) => (
          <button key={a.id} onClick={() => onSelect(a.id)} className={cn('rounded-lg border bg-card p-3 text-left', a.id === selectedId ? 'border-primary' : 'border-border hover:bg-muted')}>
            <div className="flex items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2">
                <span className="font-medium">{a.name}</span>
                <Badge variant={variant(a.status)}>{STATUS_LABEL[a.status]}</Badge>
                <span className="truncate text-sm text-muted-foreground">{taskTitle(a.taskId)}</span>
              </div>
              <div className="flex shrink-0 gap-1" onClick={(e) => e.stopPropagation()}>
                {(a.status === 'running' || a.status === 'starting') && <Button size="sm" variant="outline" onClick={() => stop(a)}><Square className="h-3.5 w-3.5" />Stop</Button>}
                {a.status !== 'running' && a.status !== 'starting' && !a.worktreeRemoved && <Button size="sm" variant="ghost" onClick={() => discard(a)}><Trash2 className="h-3.5 w-3.5" />Discard</Button>}
              </div>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1 font-mono"><GitBranch className="h-3 w-3" />{a.branch}</span>
              {a.currentActivity && <span className="truncate">{a.currentActivity}</span>}
              {a.worktreeRemoved && <span>worktree removed</span>}
            </div>
          </button>
        ))}
      </div>

      {selected && (
        <div className="flex min-h-0 flex-1 flex-col gap-2">
          <p className="break-all font-mono text-xs text-muted-foreground" title="This agent's isolated working directory">{selected.worktreePath}</p>
          {selected.status === 'running' && (
            <p className="text-xs text-muted-foreground">
              This is the real Claude Code session; you are typing into it. If Claude asks whether you trust this folder, answer in the terminal. The agent starts in planning mode with file edits and shell commands disabled.
            </p>
          )}
          <div className="min-h-0 flex-1"><TerminalView key={selected.id} projectId={projectId} agentId={selected.id} interactive={selected.status === 'running'} /></div>
        </div>
      )}
    </div>
  )
}
