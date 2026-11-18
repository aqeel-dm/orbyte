import { GitBranch, Trash2 } from 'lucide-react'
import type { Project } from '@shared/schemas/project'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'

const onboardingLabel = { pending: 'Onboarding pending', in_progress: 'Onboarding…', ready: 'Ready', failed: 'Onboarding failed' } as const

export function ProjectCard({ project, onRemove }: { project: Project; onRemove: (p: Project) => void }) {
  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate font-semibold">{project.name}</h3>
          {project.description && <p className="mt-0.5 line-clamp-2 text-sm text-muted-foreground">{project.description}</p>}
        </div>
        <Button variant="ghost" size="icon" aria-label={`Remove ${project.name}`} onClick={() => onRemove(project)}>
          <Trash2 className="h-4 w-4 text-muted-foreground" />
        </Button>
      </div>
      <p className="mt-3 truncate font-mono text-xs text-muted-foreground" title={project.repoPath}>{project.repoPath}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Badge variant={project.onboardingStatus === 'ready' ? 'success' : project.onboardingStatus === 'failed' ? 'destructive' : 'default'}>
          {onboardingLabel[project.onboardingStatus]}
        </Badge>
        {project.isGitRepo ? <Badge><GitBranch className="mr-1 h-3 w-3" />{project.defaultBranch ?? 'detached'}</Badge> : <Badge variant="warning">No Git</Badge>}
      </div>
    </Card>
  )
}
