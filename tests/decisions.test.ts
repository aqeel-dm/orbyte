import { describe, expect, it } from 'vitest'
import { DecisionRepository } from '../src/main/modules/orchestration/decision-repository'
import { makeTaskStack } from './helpers'

describe('what is waiting for the user', () => {
  it('lists pending proposals, plans awaiting a decision and results awaiting acceptance, oldest first', () => {
    const s = makeTaskStack()
    const a = s.addProject({ name: 'Alpha', repoPath: '/tmp/a' })
    const b = s.addProject({ name: 'Beta', repoPath: '/tmp/b' })
    const raw = s.handle.raw
    const task = (id: string, project: string, title: string, status: string, approval: string, updated: number) =>
      raw.prepare("insert into tasks (id, project_id, title, status, approval_status, source, updated_at) values (?, ?, ?, ?, ?, 'user', ?)").run(id, project, title, status, approval, updated)
    task('t-plan', a.id, 'Needs plan decision', 'awaiting_approval', 'pending', 2000)
    task('t-approved', a.id, 'Plan already approved', 'awaiting_approval', 'approved', 1500)
    task('t-review', b.id, 'Needs acceptance', 'in_review', 'approved', 3000)
    task('t-ready', a.id, 'Not a decision', 'ready', 'none', 100)
    task('t-done', a.id, 'Finished', 'completed', 'approved', 100)
    raw.prepare("insert into task_proposals (id, project_id, summary, items, status, created_at) values ('pr1', ?, 'Add login', '[]', 'pending', 1000)").run(a.id)
    raw.prepare("insert into task_proposals (id, project_id, summary, items, status, created_at) values ('pr2', ?, '', '[{},{}]', 'pending', 4000)").run(b.id)
    raw.prepare("insert into task_proposals (id, project_id, summary, items, status, created_at) values ('pr3', ?, 'Dismissed', '[]', 'dismissed', 500)").run(a.id)

    const repo = new DecisionRepository(s.handle.db)
    const all = repo.list()
    expect(all.map((d) => `${d.kind}:${d.title}`)).toEqual(['proposal:Add login', 'plan:Needs plan decision', 'result:Needs acceptance', 'proposal:2 proposed tasks'])
    expect(all[1]).toMatchObject({ projectName: 'Alpha', taskId: 't-plan' })
    expect(all[0]).toMatchObject({ taskId: null, projectId: a.id })

    expect(repo.list(b.id).map((d) => d.kind)).toEqual(['result', 'proposal'])
    expect(repo.list('nope')).toEqual([])
  })

  it('ignores archived projects', () => {
    const s = makeTaskStack()
    const a = s.addProject({ name: 'Alpha', repoPath: '/tmp/a' })
    s.handle.raw.prepare("insert into tasks (id, project_id, title, status, approval_status, source) values ('t', ?, 'x', 'in_review', 'approved', 'user')").run(a.id)
    const repo = new DecisionRepository(s.handle.db)
    expect(repo.list()).toHaveLength(1)
    s.projects.setStatus(a.id, 'archived')
    expect(repo.list()).toEqual([])
  })
})
