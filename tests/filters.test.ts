import { describe, expect, it } from 'vitest'
import { filterProjects, filterTasks } from '../src/shared/filters'

describe('filters', () => {
  const projects = [
    { name: 'Shop', description: 'Online store', repoPath: '/work/shop' },
    { name: 'Blog', description: 'Personal writing', repoPath: '/work/blog' }
  ]
  const tasks = [
    { title: 'Add login', description: 'Use sessions', priority: 'high' },
    { title: 'Fix typo', description: 'In the LOGIN page', priority: 'low' },
    { title: 'Refactor', description: '', priority: 'high' }
  ]
  it('matches projects on name, description or path, ignoring case, all words required', () => {
    expect(filterProjects(projects, '')).toHaveLength(2)
    expect(filterProjects(projects, 'SHOP').map((p) => p.name)).toEqual(['Shop'])
    expect(filterProjects(projects, 'writing blog').map((p) => p.name)).toEqual(['Blog'])
    expect(filterProjects(projects, 'work')).toHaveLength(2)
    expect(filterProjects(projects, 'nothing')).toEqual([])
  })
  it('filters tasks by text and priority together', () => {
    expect(filterTasks(tasks, { query: 'login', priority: 'all' }).map((t) => t.title)).toEqual(['Add login', 'Fix typo'])
    expect(filterTasks(tasks, { query: 'login', priority: 'high' }).map((t) => t.title)).toEqual(['Add login'])
    expect(filterTasks(tasks, { query: '  ', priority: 'high' })).toHaveLength(2)
    expect(filterTasks(tasks, { query: 'x', priority: 'urgent' })).toEqual([])
  })
})
