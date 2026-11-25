import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { MAX_TERMINAL_WRITE_BYTES, type AttachResult, type DeveloperAgent } from '@shared/schemas/agent'
import type { SubmittedResult } from '@shared/schemas/execution'
import type { SubmittedPlan } from '@shared/schemas/plan'
import type { AppEvent } from '@shared/schemas/team-lead'
import { AppError } from '@shared/types/result'
import type { ProjectRepository } from '../../projects/repository'
import type { TaskRepository } from '../../tasks/repository'
import type { TaskService } from '../../tasks/service'
import { AgentRepository, toPublicAgent, type AgentRecord } from './agent-repository'
import { agentEnv, buildAgentLaunch, buildExecutionLaunch } from './launch'
import type { AgentInbox } from './agent-inbox'
import type { AgentProcessReaper } from './process-reaper'
import { TerminalBuffer, lastTerminalTitle } from './terminal-buffer'
import type { TerminalHub } from './terminal-hub'
import { GitWorktrees, containment } from './worktrees'
import { log } from '../../../logging/logger'

/** The slice of node-pty the service uses. A fake implements it in tests. */
export interface PtyProcess {
  pid: number
  onData(cb: (data: string) => void): void
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(signal?: string): void
}
export interface PtyFactory {
  spawn(file: string, args: string[], opts: { cwd: string; env: Record<string, string>; cols: number; rows: number }): PtyProcess
}

export interface AgentServiceDeps {
  projects: Pick<ProjectRepository, 'get'>
  taskRepo: Pick<TaskRepository, 'get'>
  tasks: Pick<TaskService, 'transition' | 'transitionSystem'>
  agents: AgentRepository
  worktrees: GitWorktrees
  pty: PtyFactory
  hub: TerminalHub
  resolveClaude: () => string | null
  /** Per-agent private directories where the submit_plan tool drops plans. */
  inbox: AgentInbox
  /** How Claude Code starts Orbyte's plan server (Electron run as plain Node, plus the built script). */
  agentServer: { command: string; scriptPath: string }
  /** Called for each plan a PLANNING agent submits. Never approves anything. */
  onPlan?: (agentId: string, plan: SubmittedPlan) => void
  /** Progress notes and the final result from an EXECUTION agent. Self-reported: the receiver must not trust them. */
  onProgress?: (agentId: string, messages: string[]) => void
  onResult?: (agentId: string, result: SubmittedResult) => Promise<void>
  /** An execution agent's process ended (after its inbox was drained). The task's state is handled there. */
  onExecutionAgentEnded?: (agent: AgentRecord, status: AgentRecord['status']) => void
  /** Ends processes left behind by a crash. Optional so tests can omit it. */
  reaper?: AgentProcessReaper
  env: () => NodeJS.ProcessEnv
  worktreeRoot: string
  logDir: string
  emit: (event: AppEvent) => void
  maxActive?: number
  flushMs?: number
  killGraceMs?: number
}

const DEFAULT_MAX_ACTIVE = 6
const LOG_TAIL_CHARS = 1_000_000
const ID = /^[0-9a-f-]{36}$/

interface Live {
  proc: PtyProcess
  buffer: TerminalBuffer
  pending: string
  flushTimer: NodeJS.Timeout | null
  killTimer: NodeJS.Timeout | null
  inboxTimer: NodeJS.Timeout | null
  /** The drain in progress, if any: overlapping callers share it instead of skipping. */
  drainPromise: Promise<void> | null
  title: string
  lastActivityAt: number
  stopRequested: boolean
  interrupted: boolean
  done: Promise<void>
  resolveDone: () => void
}

const slug = (title: string): string =>
  title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30).replace(/-+$/g, '') || 'task'

/**
 * Starts and supervises developer agents: real `claude` CLI processes in real PTYs, each in its
 * own git worktree. Project ownership is checked on every call. The orchestrator (this service)
 * drives the task's planning state, not the agent.
 */
export class AgentService {
  private readonly live = new Map<string, Live>()
  /** Tasks whose start is in flight, so two clicks cannot start two agents. */
  private readonly starting = new Set<string>()
  /** Set when the app is quitting: no new agent may start. */
  private closing = false
  /** Starts currently running, so shutdown can wait for them (the reservation set is released earlier). */
  private inFlight = 0

  /** Worktrees being discarded right now: an execution must not start in one (checked on both sides of the git awaits). */
  private readonly discarding = new Set<string>()

  constructor(private readonly deps: AgentServiceDeps) {}

  list(projectId: string): DeveloperAgent[] {
    this.requireProject(projectId)
    return this.deps.agents.list(projectId).map(toPublicAgent)
  }

  summary(): { running: number } {
    return { running: this.deps.agents.countActive() }
  }

  async start(projectId: string, taskId: string): Promise<DeveloperAgent> {
    if (this.closing) throw new AppError('SHUTTING_DOWN', 'Orbyte is closing.')
    const project = this.requireProject(projectId)
    if (project.status === 'archived') throw new AppError('PROJECT_ARCHIVED', 'This project is archived. Restore it to continue.')
    if (project.repoSettingsTrust === 'unset') {
      throw new AppError('TRUST_REQUIRED', "Decide whether to use this repository's Claude settings (Overview tab) before starting an agent.")
    }
    if (!project.isGitRepo) throw new AppError('NOT_GIT_REPO', 'Developer agents need a Git repository for their isolated worktree. This project is not one.')

    const task = this.deps.taskRepo.get(taskId)
    if (!task || task.projectId !== projectId) throw new AppError('NOT_FOUND', 'Task not found.')
    if (task.status !== 'ready') throw new AppError('TASK_NOT_READY', 'Only a task in Ready can be started.')
    // Planning is read-only, so a task with unfinished dependencies may be planned. Approving a plan for
    // execution requires the dependencies to be completed (see ApprovalService).
    if (this.starting.has(taskId) || this.deps.agents.activeForTask(taskId)) {
      throw new AppError('AGENT_ALREADY_RUNNING', 'An agent is already working on this task.')
    }
    if (this.deps.agents.countActive() + this.starting.size >= (this.deps.maxActive ?? DEFAULT_MAX_ACTIVE)) {
      throw new AppError('TOO_MANY_AGENTS', 'Too many agents are running. Stop one first.')
    }
    const claude = this.deps.resolveClaude()
    if (!claude) throw new AppError('CLAUDE_NOT_FOUND', 'The `claude` command was not found. Install Claude Code and make sure it is on your PATH.')

    this.starting.add(taskId)
    this.inFlight++
    try {
      return await this.startReserved(project, task, claude)
    } finally {
      this.starting.delete(taskId)
      this.inFlight--
    }
  }

  private async startReserved(
    project: NonNullable<ReturnType<AgentServiceDeps['projects']['get']>>,
    task: NonNullable<ReturnType<AgentServiceDeps['taskRepo']['get']>>,
    claude: string
  ): Promise<DeveloperAgent> {
    const id = randomUUID()
    const baseBranch = project.defaultBranch ?? 'HEAD'
    const baseCommit = await this.deps.worktrees.resolveBase(project.repoPath, baseBranch)
    const branch = `orbyte/${slug(task.title)}-${id.slice(0, 8)}`
    const worktreePath = join(this.deps.worktreeRoot, project.id, id)
    const sessionId = randomUUID()

    const agent = this.deps.agents.create({
      id, projectId: project.id, taskId: task.id, name: `Agent ${id.slice(0, 4)}`, claudeSessionId: sessionId,
      worktreePath, branch, baseBranch, baseCommit
    })

    // From here the database row counts toward the limit, so the in-flight reservation is released.
    this.starting.delete(task.id)

    try {
      await this.deps.worktrees.add(project.repoPath, worktreePath, branch, baseCommit)
    } catch (err) {
      // A failed `git worktree add` can leave a directory or branch behind: clean up what exists.
      await this.cleanupFailedStart(agent)
      throw err
    }

    // The app may have started quitting while git was working: do not spawn into a closing app.
    if (this.closing) {
      await this.cleanupFailedStart(agent)
      throw new AppError('SHUTTING_DOWN', 'Orbyte is closing.')
    }

    // The orchestrator moves the task into planning; the agent does not.
    try {
      this.deps.tasks.transition(project.id, task.id, 'planning', 'orchestrator')
    } catch (err) {
      await this.cleanupFailedStart(agent)
      throw err
    }

    let proc: PtyProcess
    try {
      const inboxDir = await this.deps.inbox.prepare(id)
      proc = this.deps.pty.spawn(
        claude,
        buildAgentLaunch({
          taskTitle: task.title, taskDescription: task.description, branch, baseBranch, sessionId,
          repoSettingsTrust: project.repoSettingsTrust === 'trusted' ? 'trusted' : 'untrusted',
          agentServer: { command: this.deps.agentServer.command, scriptPath: this.deps.agentServer.scriptPath, inboxDir }
        }),
        { cwd: worktreePath, env: agentEnv(this.deps.env()), cols: 120, rows: 32 }
      )
    } catch (err) {
      log.error('[agents] spawn failed', err)
      this.returnTaskToReady(project.id, task.id)
      await this.cleanupFailedStart(agent)
      throw new AppError('SPAWN_FAILED', 'Could not start Claude Code. See the application log.')
    }

    this.register(agent, proc)

    const running = this.deps.agents.markRunning(id, proc.pid)
    this.changed(project.id, id)
    return toPublicAgent(running ?? agent)
  }

  /** Tracks a started process: output buffering, exit handling and inbox polling. */
  private register(agent: AgentRecord, proc: PtyProcess): void {
    let resolveDone!: () => void
    const done = new Promise<void>((r) => (resolveDone = r))
    const live: Live = {
      proc, buffer: new TerminalBuffer(), pending: '', flushTimer: null, killTimer: null, inboxTimer: null, drainPromise: null, title: '', lastActivityAt: 0,
      stopRequested: false, interrupted: false, done, resolveDone
    }
    this.live.set(agent.id, live)
    proc.onData((d) => this.onData(agent, live, d))
    proc.onExit((e) => void this.onExit(agent, live, e))
    // Pick up what the agent submits (polling a private directory; no listener or socket is opened).
    live.inboxTimer = setInterval(() => void this.drainInbox(agent, live), 1000)
    live.inboxTimer.unref()
  }

  stop(projectId: string, agentId: string): DeveloperAgent {
    const agent = this.requireAgent(projectId, agentId)
    if (!this.live.has(agentId)) throw new AppError('NOT_RUNNING', 'This agent is not running.')
    this.requestStop(agentId)
    return toPublicAgent(agent)
  }

  /**
   * Stops an agent and waits (up to `timeoutMs`) for its process to end. Used before an execution agent
   * takes over the planning agent's worktree. Returns whether it is stopped.
   */
  async stopAndWait(agentId: string, timeoutMs = 10_000): Promise<boolean> {
    const live = this.live.get(agentId)
    if (!live) return true
    this.requestStop(agentId)
    await Promise.race([live.done, new Promise((r) => setTimeout(r, timeoutMs))])
    return !this.live.has(agentId)
  }

  /**
   * Starts the EXECUTION agent for a task, in the worktree its planning agent used. It does not decide
   * whether execution is allowed: only the execution service calls this, after the gate. The task's state
   * is the caller's business too.
   */
  async startExecution(opts: {
    basedOn: AgentRecord
    planText: string
    planVersion: number
    feedback: string | null
    /** Runs after the agent row exists and before the process starts, so callers can record the run first. */
    beforeSpawn?: (agent: AgentRecord) => void
  }): Promise<AgentRecord> {
    if (this.closing) throw new AppError('SHUTTING_DOWN', 'Orbyte is closing.')
    const { basedOn } = opts
    const project = this.requireProject(basedOn.projectId)
    if (project.status === 'archived') throw new AppError('PROJECT_ARCHIVED', 'This project is archived. Restore it to continue.')
    if (project.repoSettingsTrust === 'unset') throw new AppError('TRUST_REQUIRED', "Decide whether to use this repository's Claude settings first.")
    const task = this.deps.taskRepo.get(basedOn.taskId)
    if (!task || task.projectId !== project.id) throw new AppError('NOT_FOUND', 'Task not found.')
    if (this.starting.has(task.id) || this.deps.agents.activeForTask(task.id)) throw new AppError('AGENT_ALREADY_RUNNING', 'An agent is already working on this task.')
    if (this.discarding.has(basedOn.worktreePath)) throw new AppError('WORKTREE_FAILED', 'The worktree is being discarded.')
    if (this.deps.agents.countActive() + this.starting.size >= (this.deps.maxActive ?? DEFAULT_MAX_ACTIVE)) throw new AppError('TOO_MANY_AGENTS', 'Too many agents are running. Stop one first.')
    const claude = this.deps.resolveClaude()
    if (!claude) throw new AppError('CLAUDE_NOT_FOUND', 'The `claude` command was not found. Install Claude Code and make sure it is on your PATH.')
    // The worktree must still exist, inside Orbyte's directory (the work lives there).
    if (basedOn.worktreeRemoved || (await containment(this.deps.worktreeRoot, basedOn.worktreePath)) !== 'inside') {
      throw new AppError('WORKTREE_FAILED', "The agent's worktree is gone, so the work cannot continue there.")
    }

    // Checked again after the await above: a discard may have begun while the path was being resolved.
    if (this.discarding.has(basedOn.worktreePath)) throw new AppError('WORKTREE_FAILED', 'The worktree is being discarded.')
    this.starting.add(task.id)
    this.inFlight++
    try {
      const id = randomUUID()
      const sessionId = randomUUID()
      const agent = this.deps.agents.create({
        id, projectId: project.id, taskId: task.id, name: `Agent ${id.slice(0, 4)}`, kind: 'execution', claudeSessionId: sessionId,
        worktreePath: basedOn.worktreePath, branch: basedOn.branch, baseBranch: basedOn.baseBranch, baseCommit: basedOn.baseCommit
      })
      this.starting.delete(task.id)
      if (this.closing) {
        this.deps.agents.finish(id, 'failed', null, 'App closing')
        throw new AppError('SHUTTING_DOWN', 'Orbyte is closing.')
      }
      let proc: PtyProcess
      try {
        opts.beforeSpawn?.(agent)
        const inboxDir = await this.deps.inbox.prepare(id)
        proc = this.deps.pty.spawn(
          claude,
          buildExecutionLaunch({
            taskTitle: task.title, taskDescription: task.description, planText: opts.planText, planVersion: opts.planVersion, feedback: opts.feedback,
            branch: basedOn.branch, baseBranch: basedOn.baseBranch, sessionId,
            repoSettingsTrust: project.repoSettingsTrust === 'trusted' ? 'trusted' : 'untrusted',
            agentServer: { command: this.deps.agentServer.command, scriptPath: this.deps.agentServer.scriptPath, inboxDir }
          }),
          { cwd: basedOn.worktreePath, env: agentEnv(this.deps.env()), cols: 120, rows: 32 }
        )
      } catch (err) {
        log.error('[agents] execution spawn failed', err)
        // The worktree holds the work: it is never removed on a failed start.
        this.deps.agents.finish(id, 'failed', null, 'Failed to start')
        this.changed(project.id, id)
        if (err instanceof AppError) throw err
        throw new AppError('SPAWN_FAILED', 'Could not start Claude Code. See the application log.')
      }
      this.register(agent, proc)
      const running = this.deps.agents.markRunning(id, proc.pid)
      this.changed(project.id, id)
      return running ?? agent
    } finally {
      this.starting.delete(task.id)
      this.inFlight--
    }
  }

  /** Archiving a project stops everything running for it. */
  stopAllForProject(projectId: string): void {
    for (const agent of this.deps.agents.list(projectId)) {
      if (this.live.has(agent.id)) this.requestStop(agent.id)
    }
  }

  /** Asks one agent's process to end (no ownership check: internal callers only). */
  stopAgentById(agentId: string): void {
    if (this.live.has(agentId)) this.requestStop(agentId)
  }

  /** Called when the user moves a task out of active work (cancel, block, back to ready): its agent must stop. */
  onTaskLeft(taskId: string): void {
    const agent = this.deps.agents.activeForTask(taskId)
    if (agent && this.live.has(agent.id)) this.requestStop(agent.id)
  }

  async discard(projectId: string, agentId: string, force = false): Promise<DeveloperAgent> {
    const agent = this.requireAgent(projectId, agentId)
    if (this.live.has(agentId) || agent.status === 'starting' || agent.status === 'running') {
      throw new AppError('AGENT_RUNNING', 'Stop the agent before discarding it.')
    }
    if (agent.worktreeRemoved) return toPublicAgent(agent)
    // A planning agent and the execution agent after it share one worktree: nothing may be running in it,
    // and the work must not be under way or under review.
    const sharing = this.deps.agents.listByWorktree(agent.worktreePath)
    if (sharing.some((a) => this.live.has(a.id) || a.status === 'starting' || a.status === 'running')) {
      throw new AppError('AGENT_RUNNING', 'Stop the agents working in this worktree before discarding it.')
    }
    const task = this.deps.taskRepo.get(agent.taskId)
    if (task && (task.status === 'in_progress' || task.status === 'in_review')) {
      throw new AppError('TASK_ACTIVE', 'This task is being implemented or reviewed. Cancel it or finish the review first.')
    }
    const project = this.requireProject(projectId)
    if (this.discarding.has(agent.worktreePath)) throw new AppError('AGENT_RUNNING', 'This worktree is already being discarded.')
    this.discarding.add(agent.worktreePath)
    try {
    // Follows symlinks, so a link swapped into the worktree directory cannot point us elsewhere.
    const where = await containment(this.deps.worktreeRoot, agent.worktreePath)
    if (where === 'outside') throw new AppError('WORKTREE_FAILED', 'The worktree is outside Orbyte\'s worktree directory.')
    if (where === 'missing') {
      // The directory is already gone (deleted by hand): forget it in git and finish the cleanup.
      await this.deps.worktrees.prune(project.repoPath)
    } else {
      if (!force) {
        if (await this.deps.worktrees.hasChanges(agent.worktreePath)) {
          throw new AppError('WORKTREE_DIRTY', 'The worktree has uncommitted changes. Discard anyway to delete them.')
        }
        if (await this.deps.worktrees.hasStrayCommits(agent.worktreePath, agent.branch, agent.baseCommit)) {
          throw new AppError('WORKTREE_DIRTY', 'The worktree has commits that are not on its branch (for example from a detached HEAD). Discard anyway to lose them.')
        }
      }
      // The awaits above gave a start the chance to begin: check again, synchronously, right before deleting.
      this.assertNothingActive(agent.worktreePath, agent.taskId)
      await this.deps.worktrees.remove(project.repoPath, agent.worktreePath, force)
    }
    await this.deps.worktrees.deleteBranchIfUnmoved(project.repoPath, agent.branch, agent.baseCommit)
    const updated = this.deps.agents.markWorktreeRemoved(agentId)
    this.deps.agents.markWorktreeRemovedByPath(agent.worktreePath)
    for (const a of sharing) await this.deps.inbox.remove(a.id)
    this.changed(projectId, agentId)
    return toPublicAgent(updated ?? agent)
    } finally {
      this.discarding.delete(agent.worktreePath)
    }
  }

  private assertNothingActive(worktreePath: string, taskId: string): void {
    if (this.deps.agents.listByWorktree(worktreePath).some((a) => this.live.has(a.id) || a.status === 'starting' || a.status === 'running') || this.starting.has(taskId)) {
      throw new AppError('AGENT_RUNNING', 'An agent started in this worktree. Stop it before discarding.')
    }
    const status = this.deps.taskRepo.get(taskId)?.status
    if (status === 'in_progress' || status === 'in_review') throw new AppError('TASK_ACTIVE', 'This task is being implemented or reviewed. Cancel it or finish the review first.')
  }

  /** Subscribes a window to this agent's terminal and returns recent output. */
  async attach(windowId: number, projectId: string, agentId: string): Promise<AttachResult> {
    const agent = this.requireAgent(projectId, agentId)
    const live = this.live.get(agentId)
    if (live) {
      // Deliver anything already buffered to current viewers first, so it is not sent again to this
      // window after it is already part of the history snapshot.
      this.flush(agentId, live)
      this.deps.hub.attach(agentId, windowId)
      return { history: live.buffer.snapshot(), live: true }
    }
    return { history: await this.readLog(agent.id), live: false }
  }

  detach(windowId: number, projectId: string, agentId: string): void {
    this.requireAgent(projectId, agentId)
    this.deps.hub.detach(agentId, windowId)
  }

  /** The user typing into the agent's Claude Code session. */
  write(projectId: string, agentId: string, data: string): void {
    const live = this.requireLive(projectId, agentId)
    if (Buffer.byteLength(data) > MAX_TERMINAL_WRITE_BYTES) throw new AppError('INVALID_INPUT', 'Too much input at once.')
    live.proc.write(data)
  }

  resize(projectId: string, agentId: string, cols: number, rows: number): void {
    this.requireLive(projectId, agentId).proc.resize(cols, rows)
  }

  /**
   * On startup: agents still marked active were interrupted by an exit. If the app crashed (so the
   * graceful shutdown never ran) their processes may still be running, so each recorded process is
   * stopped first, but only if it is verifiably that agent's `claude` process.
   */
  async recoverInterrupted(): Promise<number> {
    if (this.deps.reaper) {
      for (const agent of this.deps.agents.listActive()) {
        if (agent.pid === null) continue
        try {
          const result = await this.deps.reaper.reap(agent.pid, agent.claudeSessionId)
          if (result === 'killed') log.warn(`[agents] stopped an orphaned agent process left by a previous run (${agent.name})`)
        } catch (err) {
          log.error('[agents] orphan check failed', err)
        }
      }
    }
    const interrupted = this.deps.agents.markInterruptedAll()
    for (const agent of interrupted) {
      this.returnTaskToReady(agent.projectId, agent.taskId)
      this.changed(agent.projectId, agent.id)
    }
    return interrupted.length
  }

  /** Stops every agent (called on quit) and waits briefly for the processes to exit. */
  async shutdown(graceMs = this.deps.killGraceMs ?? 3000): Promise<void> {
    this.closing = true // no new start from here on; a start in flight aborts before it spawns
    const drainUntil = Date.now() + graceMs
    while (this.inFlight > 0 && Date.now() < drainUntil) await new Promise((r) => setTimeout(r, 25))
    const lives = [...this.live.entries()]
    for (const [id, live] of lives) {
      live.interrupted = true
      this.requestStop(id, graceMs)
    }
    await Promise.race([Promise.allSettled(lives.map(([, l]) => l.done)), new Promise((r) => setTimeout(r, graceMs + 500))])
  }

  // ---------------------------------------------------------------- internals

  private requestStop(agentId: string, graceMs = this.deps.killGraceMs ?? 3000): void {
    const live = this.live.get(agentId)
    if (!live) return
    live.stopRequested = true
    live.proc.kill('SIGTERM')
    live.killTimer ??= setTimeout(() => {
      try {
        live.proc.kill('SIGKILL')
      } catch (err) {
        log.error('[agents] SIGKILL failed', err)
      }
    }, graceMs)
  }

  private onData(agent: AgentRecord, live: Live, data: string): void {
    // This runs inside the PTY's data callback: an exception here would be an uncaught exception.
    try {
      live.buffer.append(data)
      live.pending += data
      live.flushTimer ??= setTimeout(() => this.flush(agent.id, live), this.deps.flushMs ?? 16)
      const title = lastTerminalTitle(data)
      if (title && title !== live.title) {
        live.title = title
        if (Date.now() - live.lastActivityAt > 1000) {
          live.lastActivityAt = Date.now()
          this.deps.agents.setActivity(agent.id, title)
          this.changed(agent.projectId, agent.id)
        }
      }
    } catch (err) {
      log.error('[agents] output handling failed', err)
    }
  }

  /** Reads any submitted plans and hands them to the plan service. Errors never escape. */
  private drainInbox(agent: AgentRecord, live: Live): Promise<void> {
    if (live.drainPromise) return live.drainPromise
    const p = this.doDrain(agent).finally(() => {
      live.drainPromise = null
    })
    live.drainPromise = p
    return p
  }

  private async doDrain(agent: AgentRecord): Promise<void> {
    try {
      const { plans, progress, results, rejected } = await this.deps.inbox.drain(agent.id)
      if (rejected > 0) log.warn(`[agents] discarded ${rejected} invalid file(s) from ${agent.name}`)
      // Each kind of agent may only deliver its own kind of file: a forged file of the wrong kind is ignored.
      if (agent.kind === 'planning') {
        for (const plan of plans) {
          try {
            this.deps.onPlan?.(agent.id, plan)
          } catch (err) {
            log.error('[agents] plan handling failed', err)
          }
        }
      } else {
        try {
          if (progress.length > 0) this.deps.onProgress?.(agent.id, progress)
        } catch (err) {
          log.error('[agents] progress handling failed', err)
        }
        for (const result of results) {
          try {
            await this.deps.onResult?.(agent.id, result)
          } catch (err) {
            log.error('[agents] result handling failed', err)
          }
        }
      }
    } catch (err) {
      log.error('[agents] could not read the plan inbox', err)
    }
  }

  private flush(agentId: string, live: Live): void {
    if (live.flushTimer) clearTimeout(live.flushTimer)
    live.flushTimer = null
    if (!live.pending) return
    const chunk = live.pending
    live.pending = ''
    this.deps.hub.publish(agentId, chunk)
  }

  private async onExit(agent: AgentRecord, live: Live, e: { exitCode: number; signal?: number }): Promise<void> {
    // Each step is isolated: a failure in one (for example a locked database) must not strand the rest.
    const step = (label: string, fn: () => void): void => {
      try {
        fn()
      } catch (err) {
        log.error(`[agents] exit handling: ${label} failed`, err)
      }
    }
    if (live.flushTimer) clearTimeout(live.flushTimer)
    if (live.killTimer) clearTimeout(live.killTimer)
    if (live.inboxTimer) clearInterval(live.inboxTimer)
    // A plan submitted just before exit must be recorded before the task is returned to Ready. A drain
    // already in flight may have listed the directory before the file landed, so wait for it and drain again.
    await this.drainInbox(agent, live)
    await this.drainInbox(agent, live)
    step('flush', () => this.flush(agent.id, live))
    await this.saveLog(agent.id, live.buffer)
    const status = live.interrupted ? 'interrupted' : live.stopRequested ? 'stopped' : e.exitCode === 0 ? 'exited' : 'failed'
    step('record exit', () => void this.deps.agents.finish(agent.id, status, e.exitCode, live.title))
    if (agent.kind === 'planning') {
      // If the agent ended without a plan the task goes back to Ready; if one was captured the task is
      // already awaiting approval and stays there.
      step('return task', () => this.returnTaskToReady(agent.projectId, agent.taskId))
    } else {
      // An execution agent's task is handled by the execution service (result captured, or back to the gate).
      step('execution ended', () => this.deps.onExecutionAgentEnded?.(agent, status))
    }
    step('announce', () => this.changed(agent.projectId, agent.id))
    this.deps.hub.clear(agent.id)
    this.live.delete(agent.id)
    live.resolveDone()
  }

  /**
   * Only a task still in planning goes back to Ready. If the user already moved it (cancelled or
   * blocked it, say), that decision stands; the legal blocked-to-ready move must not undo it.
   */
  private returnTaskToReady(projectId: string, taskId: string): void {
    if (this.deps.taskRepo.get(taskId)?.status !== 'planning') return
    try {
      this.deps.tasks.transitionSystem(projectId, taskId, 'ready')
    } catch (err) {
      if (!(err instanceof AppError)) log.error('[agents] could not return task to ready', err)
    }
  }

  private async cleanupFailedStart(agent: AgentRecord): Promise<void> {
    const project = this.deps.projects.get(agent.projectId)
    try {
      if (project) {
        await this.deps.worktrees.remove(project.repoPath, agent.worktreePath, true)
        await this.deps.worktrees.deleteBranchIfUnmoved(project.repoPath, agent.branch, agent.baseCommit)
      }
    } catch (err) {
      log.error('[agents] cleanup after failed start failed', err)
    }
    this.deps.agents.finish(agent.id, 'failed', null, 'Failed to start')
    this.deps.agents.markWorktreeRemoved(agent.id)
    this.changed(agent.projectId, agent.id)
  }

  private async saveLog(agentId: string, buffer: TerminalBuffer): Promise<void> {
    if (!ID.test(agentId)) return
    try {
      await mkdir(this.deps.logDir, { recursive: true, mode: 0o700 })
      await writeFile(join(this.deps.logDir, `${agentId}.log`), buffer.tail(LOG_TAIL_CHARS), { mode: 0o600 })
    } catch (err) {
      log.error('[agents] could not save terminal log', err)
    }
  }

  private async readLog(agentId: string): Promise<string> {
    if (!ID.test(agentId)) return ''
    try {
      return await readFile(join(this.deps.logDir, `${agentId}.log`), 'utf8')
    } catch {
      return ''
    }
  }

  private requireProject(projectId: string) {
    const project = this.deps.projects.get(projectId)
    if (!project) throw new AppError('NOT_FOUND', 'Project not found.')
    return project
  }

  /** Same error for "missing" and "belongs to another project". */
  private requireAgent(projectId: string, agentId: string): AgentRecord {
    const agent = this.deps.agents.get(agentId)
    if (!agent || agent.projectId !== projectId) throw new AppError('NOT_FOUND', 'Agent not found.')
    return agent
  }

  private requireLive(projectId: string, agentId: string): Live {
    const agent = this.requireAgent(projectId, agentId)
    const live = this.live.get(agentId)
    if (!live || agent.status !== 'running') throw new AppError('NOT_RUNNING', 'This agent is not running.')
    return live
  }

  private changed(projectId: string, agentId: string): void {
    try {
      this.deps.emit({ type: 'agent_changed', projectId, agentId })
    } catch (err) {
      log.error('[agents] failed to emit event', err)
    }
  }
}
