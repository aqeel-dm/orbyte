import { describe, expect, it } from 'vitest'
import { MAX_PROPOSE_CALLS_PER_TURN, makeToolHandlers, type TeamLeadTaskTools } from '../src/main/modules/agents/team-lead/tools'
import type { TeamLeadRunRequest } from '../src/main/modules/agents/team-lead/options'
import { TeamLeadService } from '../src/main/modules/agents/team-lead/service'
import { proposeTasksInputSchema } from '../src/shared/schemas/task'
import { AppError } from '../src/shared/types/result'
import { makeTaskStack, sdk } from './helpers'

const tools = (over: Partial<TeamLeadTaskTools> = {}): TeamLeadTaskTools & { proposed: unknown[] } => {
  const proposed: unknown[] = []
  return { proposed, listTasks: () => ({ tasks: [], total: 0 }), propose: (i) => { proposed.push(i); return { proposalId: 'p1', count: i.tasks.length } }, ...over }
}

describe('Team Lead tool handlers', () => {
  it('propose_tasks validates input, applies defaults, and tells the model nothing was created', async () => {
    const t = tools()
    const res = await makeToolHandlers(t).proposeTasks({ tasks: [{ title: 'A' }] })
    expect(res.isError).toBeUndefined()
    expect(res.content[0]?.text).toMatch(/Nothing has been created/)
    expect(t.proposed[0]).toMatchObject({ tasks: [{ title: 'A', priority: 'medium', dependsOnIndexes: [], dependsOnTaskIds: [] }] })
  })

  it.each([
    [{}], [{ tasks: [] }], [{ tasks: [{ title: '' }] }], [{ tasks: [{ title: 'x'.repeat(121) }] }],
    [{ tasks: Array.from({ length: 21 }, () => ({ title: 't' })) }], [{ tasks: [{ title: 'A', priority: 'asap' }] }], ['nope'], [null]
  ])('rejects invalid proposal %j as a tool error without recording anything', async (args) => {
    const t = tools()
    const res = await makeToolHandlers(t).proposeTasks(args)
    expect(res.isError).toBe(true)
    expect(t.proposed).toHaveLength(0)
  })

  it('surfaces expected service errors to the model, and hides unexpected ones', async () => {
    const expected = await makeToolHandlers(tools({ propose: () => { throw new AppError('TOO_MANY_PROPOSALS', 'review the others first') } })).proposeTasks({ tasks: [{ title: 'A' }] })
    expect(expected).toMatchObject({ isError: true })
    expect(expected.content[0]?.text).toBe('review the others first')
    const unexpected = await makeToolHandlers(tools({ propose: () => { throw new Error('SQLITE_BUSY /secret/path') } })).proposeTasks({ tasks: [{ title: 'A' }] })
    expect(unexpected.isError).toBe(true)
    expect(unexpected.content[0]?.text).not.toContain('/secret')
  })

  it('limits proposals per turn', async () => {
    const t = tools()
    const h = makeToolHandlers(t)
    for (let i = 0; i < MAX_PROPOSE_CALLS_PER_TURN; i++) expect((await h.proposeTasks({ tasks: [{ title: 'A' }] })).isError).toBeUndefined()
    expect((await h.proposeTasks({ tasks: [{ title: 'A' }] })).isError).toBe(true)
    expect(t.proposed).toHaveLength(MAX_PROPOSE_CALLS_PER_TURN)
  })

  it('list_tasks returns the compact digest', async () => {
    const tasks = [{ id: 't1', title: 'A', status: 'backlog' as const, priority: 'medium', dependsOn: [] }]
    const res = await makeToolHandlers(tools({ listTasks: () => ({ tasks, total: 3 }) })).listTasks()
    expect(JSON.parse(res.content[0]!.text)).toEqual({ tasks, total: 3, truncated: true })
  })

  it('list_tasks failures become tool errors, not exceptions', async () => {
    const gone = await makeToolHandlers(tools({ listTasks: () => { throw new AppError('NOT_FOUND', 'Project not found.') } })).listTasks()
    expect(gone).toMatchObject({ isError: true })
    const boom = await makeToolHandlers(tools({ listTasks: () => { throw new Error('SQLITE_BUSY /secret') } })).listTasks()
    expect(boom.isError).toBe(true)
    expect(boom.content[0]?.text).not.toContain('/secret')
  })
})

describe('task tools are bound server-side and only for chat turns', () => {
  function setup() {
    const t = makeTaskStack()
    const requests: TeamLeadRunRequest[] = []
    const runner = { async *run(req: TeamLeadRunRequest) { requests.push(req); yield sdk.success('ok') } }
    const bound: string[] = []
    const service = new TeamLeadService({
      projects: t.projects, chat: new (class { add() { return { id: 'm' } } list() { return [] } })() as never, runner,
      emit: () => undefined,
      taskToolsFor: (projectId) => { bound.push(projectId); return tools() }
    })
    return { t, requests, bound, service }
  }

  it('chat turns get task tools bound to that project; onboarding turns get none', async () => {
    const { t, requests, bound, service } = setup()
    const p = t.addProject()
    await service.runTurn({ projectId: p.id, prompt: 'plan it', purpose: 'chat', saveToChat: false })
    await service.runTurn({ projectId: p.id, prompt: 'onboard', purpose: 'onboarding', saveToChat: false })
    expect(requests[0]?.taskTools).not.toBeNull()
    expect(requests[1]?.taskTools).toBeNull()
    expect(bound).toEqual([p.id]) // bound once, to the server-known project id
  })

  it('the model has no way to choose a project: the tool input has no project field', () => {
    const shape = Object.keys(proposeTasksInputSchema.shape)
    expect(shape).toEqual(['summary', 'tasks'])
    expect(JSON.stringify(shape)).not.toMatch(/project/i)
  })
})
