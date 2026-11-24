import { randomUUID } from 'node:crypto'
import { AppError } from '@shared/types/result'
import type { AppEvent, ChatMessage, SendMessageResult } from '@shared/schemas/team-lead'
import type { ProjectRepository } from '../../projects/repository'
import type { ChatRepository } from './chat-repository'
import { classifyError, mapSdkMessage } from './events'
import type { TeamLeadRunner } from './runner'
import type { TeamLeadReviewTools, TeamLeadTaskTools } from './tools'

export type TurnPurpose = 'chat' | 'onboarding' | 'review'
export type TurnOutcome = { ok: true; text: string } | { ok: false; code: string; message: string; partial?: string }

const DEFAULT_TURN_TIMEOUT_MS = 15 * 60_000
const DEFAULT_CHAT_MAX_TURNS = 40

/** Fixed, user-safe messages. Raw SDK/runtime error text is logged in main and never sent to the renderer. */
const PUBLIC_MESSAGES: Record<string, string> = {
  AUTH_REQUIRED: "Claude isn't signed in. Open a terminal, run `claude`, log in, then try again.",
  SESSION_NOT_FOUND: 'The previous conversation could not be resumed.',
  INTERRUPTED: 'Turn interrupted.',
  TIMEOUT: 'The Team Lead took too long and was stopped.',
  NO_RESULT: 'The Team Lead stopped without a result.',
  NOT_FOUND: 'Project not found.',
  TURN_IN_PROGRESS: 'The Team Lead is already working on a turn.',
  SHUTTING_DOWN: 'Orbyte is closing.',
  TRUST_REQUIRED: "Decide whether to use this repository's Claude settings (Overview tab) before starting the Team Lead.",
  INTERNAL: 'Unexpected error. See the application log.',
  AGENT_ERROR: 'The Team Lead failed. See the application log for details.'
}
export const publicMessage = (code: string): string => PUBLIC_MESSAGES[code] ?? PUBLIC_MESSAGES['AGENT_ERROR']!

export interface TeamLeadDeps {
  projects: ProjectRepository
  chat: ChatRepository
  runner: TeamLeadRunner
  emit: (event: AppEvent) => void
  /** Builds the task tools for a project. Used for chat turns only. */
  taskToolsFor?: (projectId: string) => TeamLeadTaskTools
  turnTimeoutMs?: number
  chatMaxTurns?: number
}

interface TurnState {
  timedOut: boolean
}

export class TeamLeadService {
  private readonly active = new Map<string, AbortController>()
  private readonly running = new Set<Promise<unknown>>()
  /** Set when the app is quitting: no new turn may start. */
  private closing = false

  constructor(private readonly deps: TeamLeadDeps) {}

  isActive(projectId: string): boolean {
    return this.active.has(projectId)
  }

  history(projectId: string): ChatMessage[] {
    this.requireProject(projectId)
    return this.deps.chat.list(projectId)
  }

  /** Persists the user's message and starts a turn in the background. Output streams as events. */
  send(projectId: string, text: string): SendMessageResult {
    this.requireUsableProject(projectId)
    if (this.active.has(projectId)) throw new AppError('TURN_IN_PROGRESS', publicMessage('TURN_IN_PROGRESS'))
    const userMessage = this.deps.chat.add(projectId, 'user', text)
    const turnId = randomUUID()
    void this.runTurn({
      projectId,
      prompt: text,
      purpose: 'chat',
      saveToChat: true,
      turnId,
      maxTurns: this.deps.chatMaxTurns ?? DEFAULT_CHAT_MAX_TURNS
    })
    return { turnId, userMessage }
  }

  interrupt(projectId: string): void {
    this.active.get(projectId)?.abort()
  }

  /** Aborts every active turn and waits briefly for them to settle (call before closing the DB on quit). */
  async shutdown(graceMs = 3000): Promise<void> {
    this.closing = true
    for (const controller of this.active.values()) controller.abort()
    await Promise.race([Promise.allSettled([...this.running]), new Promise((r) => setTimeout(r, graceMs))])
  }

  /**
   * Runs one Team Lead turn (one SDK query, resuming the stored session). Never
   * rejects: any failure is logged, emitted as `turn_error`, and returned as an outcome.
   */
  runTurn(opts: {
    projectId: string
    prompt: string
    purpose: TurnPurpose
    saveToChat: boolean
    maxTurns?: number
    turnId?: string
    /** Only for purpose 'review': the tool that records the review of one specific plan. */
    reviewTools?: TeamLeadReviewTools
    /** Only for purpose 'review': a directory (an agent's worktree) the read-only tools may also read. */
    readDir?: string
  }): Promise<TurnOutcome> {
    const turnId = opts.turnId ?? randomUUID()
    const p = this.runTurnGuarded({ ...opts, turnId })
    this.running.add(p)
    void p.finally(() => this.running.delete(p))
    return p
  }

  private async runTurnGuarded(opts: Parameters<TeamLeadService['runTurn']>[0] & { turnId: string }): Promise<TurnOutcome> {
    try {
      return await this.runTurnInner(opts)
    } catch (err) {
      console.error(`[team-lead] unexpected failure for project ${opts.projectId}`, err)
      const outcome = { ok: false as const, code: 'INTERNAL', message: publicMessage('INTERNAL') }
      this.emit({ type: 'turn_error', projectId: opts.projectId, turnId: opts.turnId, code: outcome.code, message: outcome.message })
      return outcome
    }
  }

  private async runTurnInner(opts: Parameters<TeamLeadService['runTurn']>[0] & { turnId: string }): Promise<TurnOutcome> {
    const { projectId, purpose, turnId } = opts
    const project = this.deps.projects.get(projectId)
    if (!project) return { ok: false, code: 'NOT_FOUND', message: publicMessage('NOT_FOUND') }
    if (this.closing) return { ok: false, code: 'SHUTTING_DOWN', message: publicMessage('SHUTTING_DOWN') }
    // A second turn is refused without emitting events: events are scoped per project, and
    // a stray terminal event would corrupt the turn that is actually running.
    if (this.active.has(projectId)) return { ok: false, code: 'TURN_IN_PROGRESS', message: publicMessage('TURN_IN_PROGRESS') }

    const abort = new AbortController()
    const state: TurnState = { timedOut: false }
    const timer = setTimeout(() => {
      state.timedOut = true
      abort.abort()
    }, this.deps.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS)
    this.active.set(projectId, abort)

    try {
      this.emit({ type: 'turn_started', projectId, turnId, purpose })
      // A plan comes from an agent and may carry hostile text, so a review never joins the user's chat
      // session: it runs in its own one-shot session and never touches the stored session id.
      const outcome = await this.runWithResumeFallback({ ...opts, purpose }, turnId, abort, state, purpose === 'review' ? null : project.teamLeadSessionId)

      if (outcome.ok) {
        const messageId = opts.saveToChat && outcome.text.trim() ? this.deps.chat.add(projectId, 'assistant', outcome.text).id : null
        this.emit({ type: 'turn_completed', projectId, turnId, messageId })
      } else {
        // Keep real partial output from an interrupted chat turn so history matches what the user saw.
        if (opts.saveToChat && outcome.partial?.trim()) this.deps.chat.add(projectId, 'assistant', outcome.partial)
        this.emit({ type: 'turn_error', projectId, turnId, code: outcome.code, message: outcome.message })
      }
      return outcome
    } finally {
      clearTimeout(timer)
      this.active.delete(projectId)
    }
  }

  private async runWithResumeFallback(
    opts: { projectId: string; prompt: string; maxTurns?: number; purpose: TurnPurpose; reviewTools?: TeamLeadReviewTools; readDir?: string },
    turnId: string,
    abort: AbortController,
    state: TurnState,
    storedSessionId: string | null
  ): Promise<TurnOutcome> {
    const first = await this.attempt(opts, turnId, abort, state, storedSessionId)
    // An unknown session id (for example the session file is gone) is recoverable: start fresh once.
    if (!first.ok && first.code === 'SESSION_NOT_FOUND' && storedSessionId) {
      this.deps.projects.setTeamLeadSession(opts.projectId, null)
      return this.attempt(opts, turnId, abort, state, null)
    }
    return first
  }

  private async attempt(
    opts: { projectId: string; prompt: string; maxTurns?: number; purpose: TurnPurpose; reviewTools?: TeamLeadReviewTools; readDir?: string },
    turnId: string,
    abort: AbortController,
    state: TurnState,
    resumeSessionId: string | null
  ): Promise<TurnOutcome> {
    const { projectId } = opts
    const project = this.deps.projects.get(projectId)
    if (!project) return { ok: false, code: 'NOT_FOUND', message: publicMessage('NOT_FOUND') }
    if (project.repoSettingsTrust === 'unset') return { ok: false, code: 'TRUST_REQUIRED', message: publicMessage('TRUST_REQUIRED') }

    let streamed = ''
    const assistantTexts: string[] = []
    let result: TurnOutcome | null = null
    const partial = (): string => streamed || assistantTexts.join('\n\n')

    try {
      const stream = this.deps.runner.run({
        prompt: opts.prompt,
        repoPath: project.repoPath,
        resumeSessionId,
        trustRepoSettings: project.repoSettingsTrust === 'trusted',
        // Only chat turns (started by the user's message) get task tools. Onboarding never proposes work.
        taskTools: opts.purpose === 'chat' && this.deps.taskToolsFor ? this.deps.taskToolsFor(projectId) : null,
        // Only review turns get the review tool, and then no task tools.
        reviewTools: opts.purpose === 'review' ? (opts.reviewTools ?? null) : null,
        ephemeral: opts.purpose === 'review',
        ...(opts.purpose === 'review' && opts.readDir ? { readDir: opts.readDir } : {}),
        abortController: abort,
        ...(opts.maxTurns !== undefined ? { maxTurns: opts.maxTurns } : {})
      })
      for await (const raw of stream) {
        for (const sig of mapSdkMessage(raw)) {
          switch (sig.kind) {
            case 'session':
              if (opts.purpose !== 'review' && sig.sessionId !== this.deps.projects.get(projectId)?.teamLeadSessionId) {
                this.deps.projects.setTeamLeadSession(projectId, sig.sessionId)
              }
              break
            case 'text_block_start':
              // Keep separate text blocks (split by tool calls) from running together.
              if (streamed) {
                streamed += '\n\n'
                this.emit({ type: 'text_delta', projectId, turnId, text: '\n\n' })
              }
              break
            case 'text_delta':
              streamed += sig.text
              this.emit({ type: 'text_delta', projectId, turnId, text: sig.text })
              break
            case 'assistant_text':
              assistantTexts.push(sig.text)
              break
            case 'tool':
              this.emit({ type: 'tool_activity', projectId, turnId, tool: sig.tool })
              break
            case 'success':
              result = { ok: true, text: streamed || assistantTexts.join('\n\n') || sig.text }
              break
            case 'error':
              console.error(`[team-lead] ${sig.code} for project ${projectId}: ${sig.message}`)
              result = { ok: false, code: sig.code, message: publicMessage(sig.code) }
              break
          }
        }
      }
    } catch (err) {
      if (abort.signal.aborted) return this.abortedOutcome(state, partial())
      // The SDK throws after emitting an error result; prefer the structured outcome if we have one.
      if (!result) {
        const raw = err instanceof Error ? err.message : String(err)
        const code = classifyError(raw)
        console.error(`[team-lead] ${code} for project ${projectId}: ${raw}`)
        return { ok: false, code, message: publicMessage(code) }
      }
    }

    if (abort.signal.aborted) return this.abortedOutcome(state, partial())
    return result ?? { ok: false, code: 'NO_RESULT', message: publicMessage('NO_RESULT') }
  }

  /** Reported as a failure so callers (and onboarding) never treat an interrupt or timeout as success. */
  private abortedOutcome(state: TurnState, partial: string): TurnOutcome {
    const code = state.timedOut ? 'TIMEOUT' : 'INTERRUPTED'
    return { ok: false, code, message: publicMessage(code), partial }
  }

  /** Event delivery must never break a turn (for example a destroyed window). */
  private emit(event: AppEvent): void {
    try {
      this.deps.emit(event)
    } catch (err) {
      console.error('[team-lead] failed to emit event', err)
    }
  }

  private requireProject(projectId: string) {
    const project = this.deps.projects.get(projectId)
    if (!project) throw new AppError('NOT_FOUND', publicMessage('NOT_FOUND'))
    return project
  }

  private requireUsableProject(projectId: string): void {
    const project = this.requireProject(projectId)
    if (project.status === 'archived') throw new AppError('PROJECT_ARCHIVED', 'This project is archived. Restore it to continue.')
    if (project.repoSettingsTrust === 'unset') throw new AppError('TRUST_REQUIRED', publicMessage('TRUST_REQUIRED'))
    // Onboarding owns the turn slot until it finishes; chatting now would collide with it.
    if (project.onboardingStatus === 'in_progress') {
      throw new AppError('ONBOARDING_IN_PROGRESS', 'Onboarding is still running. Wait for it to finish.')
    }
  }
}
