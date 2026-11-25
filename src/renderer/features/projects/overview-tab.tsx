import { FileText, GitBranch, Loader2, TriangleAlert } from 'lucide-react'
import { useState } from 'react'
import type { Project } from '@shared/schemas/project'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { AUTH_HELP } from '@/hooks/use-team-lead-chat'
import { ActivityList } from './activity-list'
import { DecisionList } from './decision-list'
import { UsageCard } from './usage-card'
import { TrustPanel } from './trust-panel'

const statusLabel = { pending: 'Not onboarded', in_progress: 'Onboarding…', ready: 'Ready', failed: 'Onboarding failed' } as const

export function OverviewTab({ project, onChanged }: { project: Project; onChanged: () => void }) {
  const [error, setError] = useState<string | null>(null)
  const data = project.onboardingData
  const running = project.onboardingStatus === 'in_progress'
  const needsTrust = project.repoSettingsTrust === 'unset'

  async function start() {
    setError(null)
    const res = await window.orbyte.onboarding.start(project.id)
    if (!res.ok) setError(res.error.message)
    onChanged()
  }

  return (
    <div className="space-y-4 overflow-auto pb-8">
      <Card className="p-4">
        <p className="break-all font-mono text-xs text-muted-foreground">{project.repoPath}</p>
        {project.description && <p className="mt-2 text-sm">{project.description}</p>}
        <div className="mt-3 flex flex-wrap gap-2">
          {project.isGitRepo ? <Badge><GitBranch className="mr-1 h-3 w-3" />{project.defaultBranch ?? 'detached'}</Badge> : <Badge variant="warning"><TriangleAlert className="mr-1 h-3 w-3" />No Git: limited (developer agents unavailable)</Badge>}
          {project.status === 'archived' && <Badge variant="warning">Archived</Badge>}
        </div>
      </Card>

      <TrustPanel project={project} onChanged={onChanged} />

      <Card className="p-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <h2 className="font-semibold">Onboarding</h2>
            <Badge variant={project.onboardingStatus === 'ready' ? 'success' : project.onboardingStatus === 'failed' ? 'destructive' : 'default'}>{statusLabel[project.onboardingStatus]}</Badge>
          </div>
          <Button size="sm" onClick={start} disabled={running || needsTrust || project.status === 'archived'}>
            {running ? <><Loader2 className="h-4 w-4 animate-spin" />Running</> : project.onboardingStatus === 'pending' ? 'Start onboarding' : 'Re-run onboarding'}
          </Button>
        </div>
        <p className="mt-2 text-sm text-muted-foreground">The Team Lead reads your repository's own instructions and documentation (read-only) and summarizes the project. Nothing is written to your repository.</p>
        {error && <p role="alert" className="mt-2 text-sm text-destructive">{error}</p>}
        {data?.error && <p role="alert" className="mt-2 text-sm text-destructive">{data.error.code === 'AUTH_REQUIRED' ? AUTH_HELP : data.error.message}</p>}
      </Card>

      {data?.discovery && (
        <Card className="p-4">
          <h2 className="font-semibold">Discovered instructions</h2>
          <ul className="mt-2 space-y-1 text-sm">
            {data.discovery.claudeMdFiles.map((f) => <li key={f.path} className="flex items-center gap-2"><FileText className="h-3.5 w-3.5 text-muted-foreground" /><span className="font-mono text-xs">{f.path}</span></li>)}
            {data.discovery.claudeDir.exists && <li className="text-muted-foreground">.claude/: {data.discovery.claudeDir.rules.length} rules, {data.discovery.claudeDir.skills.length} skills, {data.discovery.claudeDir.agents.length} agents{data.discovery.claudeDir.hasHooks ? ', hooks configured' : ''}</li>}
            {data.discovery.hasMcpConfig && <li className="text-muted-foreground">.mcp.json present</li>}
            {data.discovery.docs.map((f) => <li key={f.path} className="font-mono text-xs text-muted-foreground">{f.path}</li>)}
            {data.discovery.claudeMdFiles.length === 0 && !data.discovery.claudeDir.exists && data.discovery.docs.length === 0 && <li className="text-muted-foreground">No CLAUDE.md, .claude/ or documentation found.</li>}
          </ul>
          {(data.discovery.claudeDir.riskySettingsKeys?.length ?? 0) > 0 && <p className="mt-2 text-xs text-warning">This repository's Claude settings include: {data.discovery.claudeDir.riskySettingsKeys?.join(', ')}. These can run code or change behavior when the Team Lead works in it (only if you trust the repository).</p>}
          {data.discovery.truncated && <p className="mt-2 text-xs text-muted-foreground">Discovery was limited to keep it bounded.</p>}
        </Card>
      )}

      {data?.summary && (
        <Card className="p-4">
          <h2 className="font-semibold">Team Lead's understanding</h2>
          <p className="mt-2 whitespace-pre-wrap break-words text-sm">{data.summary}</p>
        </Card>
      )}
      <UsageCard projectId={project.id} />
      <DecisionList projectId={project.id} />
      <ActivityList projectId={project.id} />

      {data?.workflowGuidance && (
        <Card className="p-4">
          <h2 className="font-semibold">Proposed workflow guidance</h2>
          <p className="mt-1 text-xs text-muted-foreground">A proposal for you to review. It is stored in Orbyte only, not in your repository.</p>
          <p className="mt-2 whitespace-pre-wrap break-words text-sm">{data.workflowGuidance}</p>
        </Card>
      )}
    </div>
  )
}
