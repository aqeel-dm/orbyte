/** Plain filtering helpers for the lists in the UI (search is case-insensitive, matches any word order). */

const norm = (s: string) => s.toLocaleLowerCase()
const terms = (q: string) => norm(q).split(/\s+/).filter(Boolean)
const matches = (haystack: string, q: string) => {
  const h = norm(haystack)
  return terms(q).every((t) => h.includes(t))
}

export function filterProjects<T extends { name: string; description: string; repoPath: string }>(projects: T[], query: string): T[] {
  return terms(query).length === 0 ? projects : projects.filter((p) => matches(`${p.name}\n${p.description}\n${p.repoPath}`, query))
}

export function filterTasks<T extends { title: string; description: string; priority: string }>(tasks: T[], f: { query: string; priority: string | 'all' }): T[] {
  return tasks.filter((t) => (f.priority === 'all' || t.priority === f.priority) && (terms(f.query).length === 0 || matches(`${t.title}\n${t.description}`, f.query)))
}
