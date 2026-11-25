import { describe, expect, it } from 'vitest'
import { ActivityRepository } from '../src/main/modules/projects/activity-repository'
import { summarizeTeamLeads } from '../src/main/modules/agents/team-lead/summary'
import { makeTaskStack } from './helpers'

describe('recent activity across projects', () => {
  it('lists newest first with the project name, includes app-wide events and leaves out archived projects', () => {
    const s = makeTaskStack()
    const a = s.addProject({ name: 'Alpha', repoPath: '/tmp/a' })
    const b = s.addProject({ name: 'Beta', repoPath: '/tmp/b' })
    const raw = s.handle.raw
    const ins = (project: string | null, type: string, at: number) =>
      raw.prepare('insert into activity_events (id, project_id, type, payload, created_at) values (?, ?, ?, ?, ?)').run(`seed:${type}`, project, type, '{}', at)
    const t = Date.now() + 10_000_000 // after the events created by registering the projects
    ins(a.id, 'a.old', t + 1000); ins(b.id, 'b.mid', t + 2000); ins(null, 'recovery.completed', t + 3000); ins(a.id, 'a.new', t + 4000)
    const repo = new ActivityRepository(s.handle.db)

    const recent = repo.listRecent(50).filter((e) => e.id.startsWith('seed:'))
    expect(recent.map((e) => e.type)).toEqual(['a.new', 'recovery.completed', 'b.mid', 'a.old'])
    expect(recent[0]).toMatchObject({ projectId: a.id, projectName: 'Alpha' })
    expect(recent[1]).toMatchObject({ projectId: null, projectName: null })

    s.projects.setStatus(b.id, 'archived')
    expect(repo.listRecent(50).map((e) => e.type)).not.toContain('b.mid')
    expect(repo.listRecent(2).map((e) => e.type)).toEqual(['a.new', 'recovery.completed'])
  })
})

describe('summarizeTeamLeads', () => {
  const p = (id: string, status: 'active' | 'archived', onboardingStatus: 'pending' | 'ready' | 'failed' | 'in_progress') => ({ id, status, onboardingStatus })
  it('counts ready Team Leads and running turns in active projects only', () => {
    const list = [p('1', 'active', 'ready'), p('2', 'active', 'pending'), p('3', 'archived', 'ready'), p('4', 'active', 'ready')]
    expect(summarizeTeamLeads(list, (id) => id === '1' || id === '3')).toEqual({ ready: 2, working: 1 })
    expect(summarizeTeamLeads([], () => true)).toEqual({ ready: 0, working: 0 })
  })
})
