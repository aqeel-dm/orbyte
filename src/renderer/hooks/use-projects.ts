import { useCallback, useEffect, useState } from 'react'
import type { Project } from '@shared/schemas/project'

export function useProjects(includeArchived: boolean) {
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setError(null)
    try {
      const res = await window.orbyte.projects.list({ includeArchived })
      if (res.ok) setProjects(res.data)
      else setError(res.error.message)
    } catch {
      setError('Cannot reach the application backend.')
    } finally {
      setLoading(false)
    }
  }, [includeArchived])

  useEffect(() => void refresh(), [refresh])
  // Onboarding runs in the background; keep the list current.
  useEffect(() => window.orbyte.onEvent((e) => { if (e.type === 'project_updated') void refresh() }), [refresh])
  return { projects, loading, error, refresh }
}
