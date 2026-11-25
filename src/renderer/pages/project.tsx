import { ArrowLeft, Loader2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { ChatTab } from '@/features/team-lead/chat-tab'
import { AgentsTab } from '@/features/agents/agents-tab'
import { TasksTab } from '@/features/tasks/tasks-tab'
import { useAgents } from '@/hooks/use-agents'
import { useTasks } from '@/hooks/use-tasks'
import { OverviewTab } from '@/features/projects/overview-tab'
import { useProject } from '@/hooks/use-project'
import { cn } from '@/lib/utils'

type Tab = 'overview' | 'chat' | 'tasks' | 'agents'

export function ProjectPage() {
  const { id = '' } = useParams()
  const { project, loading, error, refresh } = useProject(id)
  const [search, setSearch] = useSearchParams()
  const wanted = search.get('tab')
  const [tab, setTab] = useState<Tab>(wanted === 'tasks' || wanted === 'agents' || wanted === 'chat' ? wanted : 'overview')
  // Keep the URL in step with the tab, so a link to ?tab=... from this page changes the tab too.
  const selectTab = (t: Tab) => { setTab(t); setSearch(t === 'overview' ? {} : { tab: t }, { replace: true }) }
  // A link from the overview (same page, new ?tab=) must switch the tab too.
  useEffect(() => { if (wanted === 'tasks' || wanted === 'agents' || wanted === 'chat') setTab(wanted) }, [wanted])
  const { pending, tasks } = useTasks(id)
  const awaitingDecision = tasks.filter((t) => t.status === 'awaiting_approval' && t.approvalStatus === 'pending').length
  const { running } = useAgents(id)
  const [agentId, setAgentId] = useState<string | null>(null)

  if (loading) return <div className="flex items-center gap-2 p-12 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Loading…</div>
  if (!project) return <div className="p-12"><p role="alert" className="text-sm text-destructive">{error ?? 'Project not found.'}</p><Link to="/" className="mt-3 inline-block text-sm text-primary">Back to dashboard</Link></div>

  const tabClass = (t: Tab) => cn('border-b-2 px-3 py-2 text-sm', tab === t ? 'border-primary font-medium' : 'border-transparent text-muted-foreground hover:text-foreground')
  return (
    <div className="mx-auto flex h-screen max-w-4xl flex-col px-8 pb-6 pt-12">
      <Link to="/" className="mb-2 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="h-3.5 w-3.5" />Dashboard</Link>
      <h1 className="truncate text-2xl font-semibold">{project.name}</h1>
      <nav className="mt-4 flex border-b border-border" aria-label="Project sections">
        <button className={tabClass('overview')} onClick={() => selectTab('overview')}>Overview</button>
        <button className={tabClass('chat')} onClick={() => selectTab('chat')}>Team Lead</button>
        <button className={tabClass('tasks')} onClick={() => selectTab('tasks')}>Tasks{pending.length + awaitingDecision > 0 && <span className="ml-1.5 rounded-full bg-primary px-1.5 py-0.5 text-xs text-primary-foreground" title="Proposals and plans waiting for your decision">{pending.length + awaitingDecision}</span>}</button>
        <button className={tabClass('agents')} onClick={() => selectTab('agents')}>Agents{running > 0 && <span className="ml-1.5 rounded-full bg-success px-1.5 py-0.5 text-xs text-background" title="Agents running">{running}</span>}</button>
      </nav>
      <div className="mt-4 min-h-0 flex-1">
        {tab === 'overview' ? <OverviewTab project={project} onChanged={refresh} /> : tab === 'tasks' ? <TasksTab projectId={project.id} repoPath={project.repoPath} archived={project.status === 'archived'} onAgentStarted={(id) => { setAgentId(id); selectTab('agents') }} /> : tab === 'agents' ? <AgentsTab projectId={project.id} selectedId={agentId} onSelect={setAgentId} /> : <ChatTab pendingProposals={pending.length} onOpenTasks={() => selectTab('tasks')} projectId={project.id} disabled={project.status === 'archived' || project.repoSettingsTrust === 'unset'} disabledReason={project.status === 'archived' ? 'This project is archived.' : "Decide on this repository's Claude settings in the Overview tab first."} />}
      </div>
    </div>
  )
}
