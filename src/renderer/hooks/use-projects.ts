import { useCallback, useEffect, useState } from 'react'
import type { Project } from '@shared/schemas/project'

export function useProjects() {
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setError(null)
    try {
      const res = await window.orbyte.projects.list()
      if (res.ok) setProjects(res.data)
      else setError(res.error.message)
    } catch {
      setError('Cannot reach the application backend.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => void refresh(), [refresh])
  return { projects, loading, error, refresh }
}
