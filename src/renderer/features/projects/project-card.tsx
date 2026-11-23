import { Archive, ArchiveRestore, GitBranch } from 'lucide-react'
import { Link } from 'react-router-dom'
import type { Project } from '@shared/schemas/project'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'

const onboardingLabel = { pending: 'Not onboarded', in_progress: 'Onboarding…', ready: 'Ready', failed: 'Onboarding failed' } as const

export function ProjectCard({ project, onArchive, onRestore }: { project: Project; onArchive: (p: Project) => void; onRestore: (p: Project) => void }) {
  const archived = project.status === 'archived'
  return (
    <Card className={`p-4 ${archived ? 'opacity-70' : ''}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate font-semibold">
            {archived ? project.name : <Link to={`/projects/${project.id}`} className="hover:text-primary hover:underline">{project.name}</Link>}
          </h3>
          {project.description && <p className="mt-0.5 line-clamp-2 text-sm text-muted-foreground">{project.description}</p>}
        </div>
        {archived ? (
          <Button variant="ghost" size="icon" aria-label={`Restore ${project.name}`} onClick={() => onRestore(project)}><ArchiveRestore className="h-4 w-4 text-muted-foreground" /></Button>
        ) : (
          <Button variant="ghost" size="icon" aria-label={`Archive ${project.name}`} onClick={() => onArchive(project)}><Archive className="h-4 w-4 text-muted-foreground" /></Button>
        )}
      </div>
      <p className="mt-3 truncate font-mono text-xs text-muted-foreground" title={project.repoPath}>{project.repoPath}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {archived && <Badge variant="warning">Archived</Badge>}
        <Badge variant={project.onboardingStatus === 'ready' ? 'success' : project.onboardingStatus === 'failed' ? 'destructive' : 'default'}>{onboardingLabel[project.onboardingStatus]}</Badge>
        {project.isGitRepo ? <Badge><GitBranch className="mr-1 h-3 w-3" />{project.defaultBranch ?? 'detached'}</Badge> : <Badge variant="warning">No Git: limited</Badge>}
      </div>
    </Card>
  )
}
