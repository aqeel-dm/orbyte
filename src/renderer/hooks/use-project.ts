import { useCallback, useEffect, useState } from 'react'
import type { Project } from '@shared/schemas/project'

export function useProject(id: string) {
  const [project, setProject] = useState<Project | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const res = await window.orbyte.projects.get(id)
      if (res.ok) { setProject(res.data); setError(null) } else setError(res.error.message)
    } catch {
      setError('Cannot reach the application backend.')
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => void refresh(), [refresh])
  useEffect(() => window.orbyte.onEvent((e) => { if (e.type === 'project_updated' && e.projectId === id) void refresh() }), [id, refresh])
  return { project, loading, error, refresh }
}
