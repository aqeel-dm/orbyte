import { randomUUID } from 'node:crypto'
import { AppError } from '@shared/types/result'
import type { AppEvent, ChatMessage, SendMessageResult } from '@shared/schemas/team-lead'
import type { ProjectRepository } from '../../projects/repository'
import type { ChatRepository } from './chat-repository'
import { classifyError, mapSdkMessage } from './events'
import type { TeamLeadRunner } from './runner'

export type TurnPurpose = 'chat' | 'onboarding'
export type TurnOutcome = { ok: true; text: string } | { ok: false; code: string; message: string; partial?: string }

export interface TeamLeadDeps {
  projects: ProjectRepository
  chat: ChatRepository
  runner: TeamLeadRunner
  emit: (event: AppEvent) => void
}

export class TeamLeadService {
  private readonly active = new Map<string, AbortController>()

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
    if (this.active.has(projectId)) throw new AppError('TURN_IN_PROGRESS', 'The Team Lead is already working on a turn.')
    const userMessage = this.deps.chat.add(projectId, 'user', text)
    const turnId = randomUUID()
    void this.runTurn({ projectId, prompt: text, purpose: 'chat', saveToChat: true, turnId })
    return { turnId, userMessage }
  }

  interrupt(projectId: string): void {
    this.active.get(projectId)?.abort()
  }

  /**
   * Runs one Team Lead turn (one SDK query, resuming the stored session). Never
   * throws: failures are emitted as `turn_error` and returned as an outcome.
   */
  async runTurn(opts: {
    projectId: string
    prompt: string
    purpose: TurnPurpose
    saveToChat: boolean
    maxTurns?: number
    turnId?: string
  }): Promise<TurnOutcome> {
    const { projectId, purpose } = opts
    const turnId = opts.turnId ?? randomUUID()
    const emit = this.deps.emit
    const project = this.deps.projects.get(projectId)
    if (!project) return { ok: false, code: 'NOT_FOUND', message: 'Project not found.' }
    if (this.active.has(projectId)) {
      const outcome = { ok: false as const, code: 'TURN_IN_PROGRESS', message: 'The Team Lead is already working on a turn.' }
      emit({ type: 'turn_error', projectId, turnId, code: outcome.code, message: outcome.message })
      return outcome
    }

    const abort = new AbortController()
    this.active.set(projectId, abort)
    emit({ type: 'turn_started', projectId, turnId, purpose })

    let outcome: TurnOutcome
    try {
      outcome = await this.runWithResumeFallback(opts, turnId, abort, project.teamLeadSessionId)
    } finally {
      this.active.delete(projectId)
    }

    if (outcome.ok) {
      let messageId: string | null = null
      if (opts.saveToChat && outcome.text.trim()) messageId = this.deps.chat.add(projectId, 'assistant', outcome.text).id
      emit({ type: 'turn_completed', projectId, turnId, messageId })
    } else {
      // Keep real partial output from an interrupted chat turn so history matches what the user saw.
      if (opts.saveToChat && outcome.partial?.trim()) this.deps.chat.add(projectId, 'assistant', outcome.partial)
      emit({ type: 'turn_error', projectId, turnId, code: outcome.code, message: outcome.message })
    }
    return outcome
  }

  private async runWithResumeFallback(
    opts: { projectId: string; prompt: string; maxTurns?: number; saveToChat: boolean },
    turnId: string,
    abort: AbortController,
    storedSessionId: string | null
  ): Promise<TurnOutcome> {
    const first = await this.attempt(opts, turnId, abort, storedSessionId)
    // An unknown session id (for example the session file is gone) is recoverable: start fresh once.
    if (!first.ok && first.code === 'SESSION_NOT_FOUND' && storedSessionId) {
      this.deps.projects.setTeamLeadSession(opts.projectId, null)
      return this.attempt(opts, turnId, abort, null)
    }
    return first
  }

  private async attempt(
    opts: { projectId: string; prompt: string; maxTurns?: number },
    turnId: string,
    abort: AbortController,
    resumeSessionId: string | null
  ): Promise<TurnOutcome> {
    const { projectId } = opts
    const project = this.deps.projects.get(projectId)
    if (!project) return { ok: false, code: 'NOT_FOUND', message: 'Project not found.' }

    let streamed = ''
    const assistantTexts: string[] = []
    let result: TurnOutcome | null = null

    try {
      const stream = this.deps.runner.run({
        prompt: opts.prompt,
        repoPath: project.repoPath,
        resumeSessionId,
        abortController: abort,
        ...(opts.maxTurns !== undefined ? { maxTurns: opts.maxTurns } : {})
      })
      for await (const raw of stream) {
        for (const sig of mapSdkMessage(raw)) {
          switch (sig.kind) {
            case 'session':
              if (sig.sessionId !== this.deps.projects.get(projectId)?.teamLeadSessionId) {
                this.deps.projects.setTeamLeadSession(projectId, sig.sessionId)
              }
              break
            case 'text_block_start':
              // Keep separate text blocks (split by tool calls) from running together.
              if (streamed) {
                streamed += '\n\n'
                this.deps.emit({ type: 'text_delta', projectId, turnId, text: '\n\n' })
              }
              break
            case 'text_delta':
              streamed += sig.text
              this.deps.emit({ type: 'text_delta', projectId, turnId, text: sig.text })
              break
            case 'assistant_text':
              assistantTexts.push(sig.text)
              break
            case 'tool':
              this.deps.emit({ type: 'tool_activity', projectId, turnId, tool: sig.tool })
              break
            case 'success':
              result = { ok: true, text: streamed || assistantTexts.join('\n\n') || sig.text }
              break
            case 'error':
              result = { ok: false, code: sig.code, message: sig.message }
              break
          }
        }
      }
    } catch (err) {
      if (abort.signal.aborted) return partialOrInterrupted(streamed || assistantTexts.join('\n\n'))
      // The SDK throws after emitting an error result; prefer the structured outcome if we have one.
      if (!result) {
        const message = err instanceof Error ? err.message : String(err)
        return { ok: false, code: classifyError(message), message }
      }
    }

    if (abort.signal.aborted) return partialOrInterrupted(streamed || assistantTexts.join('\n\n'))
    return result ?? { ok: false, code: 'NO_RESULT', message: 'The Team Lead stopped without a result.' }
  }

  private requireProject(projectId: string) {
    const project = this.deps.projects.get(projectId)
    if (!project) throw new AppError('NOT_FOUND', 'Project not found.')
    return project
  }

  private requireUsableProject(projectId: string): void {
    if (this.requireProject(projectId).status === 'archived') {
      throw new AppError('PROJECT_ARCHIVED', 'This project is archived. Restore it to continue.')
    }
  }
}

function partialOrInterrupted(text: string): TurnOutcome {
  // Reported as a failure so callers (and onboarding) never treat an interrupt as success.
  return { ok: false, code: 'INTERRUPTED', message: 'Turn interrupted.', partial: text }
}
