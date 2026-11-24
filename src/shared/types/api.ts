import type { DiscoveryResult } from '../schemas/onboarding'
import type { ListProjectsInput, PickDirectoryResult, Project, RegisterProjectInput } from '../schemas/project'
import type { AppEvent, ChatMessage, SendMessageResult } from '../schemas/team-lead'
import type { AgentSummary, AttachResult, DeveloperAgent, TerminalEvent } from '../schemas/agent'
import type { ActivityEvent, CreateTaskInput, ProposalItem, Task, TaskProposal, TaskSummary, UpdateTaskInput } from '../schemas/task'
import type { TaskStatus } from '../task-state'
import type { Result } from './result'

/** The entire surface exposed to the renderer as `window.orbyte`. */
export interface OrbyteApi {
  projects: {
    list(input?: ListProjectsInput): Promise<Result<Project[]>>
    get(id: string): Promise<Result<Project>>
    pickDirectory(): Promise<Result<PickDirectoryResult>>
    register(input: RegisterProjectInput): Promise<Result<Project>>
    archive(id: string): Promise<Result<Project>>
    restore(id: string): Promise<Result<Project>>
    /** Decide whether the repository's own Claude settings (hooks etc.) may load for the Team Lead. */
    setTrust(id: string, trust: 'trusted' | 'untrusted'): Promise<Result<Project>>
    /** Read-only listing of repo-owned instruction files and risky settings keys. */
    discover(id: string): Promise<Result<DiscoveryResult>>
  }
  onboarding: {
    /** Starts onboarding in the background; progress arrives as events. */
    start(projectId: string): Promise<Result<Project>>
  }
  teamLead: {
    /** Starts a turn; streamed output arrives as events. */
    send(projectId: string, text: string): Promise<Result<SendMessageResult>>
    interrupt(projectId: string): Promise<Result<null>>
    history(projectId: string): Promise<Result<ChatMessage[]>>
  }
  tasks: {
    list(projectId: string): Promise<Result<Task[]>>
    create(input: CreateTaskInput): Promise<Result<Task>>
    update(input: UpdateTaskInput): Promise<Result<Task>>
    /** Moves a task as the user. Only moves the state machine allows for users are accepted. */
    transition(projectId: string, taskId: string, to: TaskStatus): Promise<Result<Task>>
    summary(): Promise<Result<TaskSummary>>
  }
  proposals: {
    list(projectId: string): Promise<Result<TaskProposal[]>>
    /** Creates the given (possibly edited, possibly partial) tasks from a pending proposal. */
    approve(projectId: string, proposalId: string, items: ProposalItem[]): Promise<Result<Task[]>>
    dismiss(projectId: string, proposalId: string): Promise<Result<TaskProposal>>
  }
  activity: {
    list(projectId: string, limit?: number): Promise<Result<ActivityEvent[]>>
  }
  agents: {
    list(projectId: string): Promise<Result<DeveloperAgent[]>>
    /** Starts a developer agent (a real Claude Code process in its own git worktree) for a ready task. */
    start(projectId: string, taskId: string): Promise<Result<DeveloperAgent>>
    stop(projectId: string, agentId: string): Promise<Result<DeveloperAgent>>
    /** Removes the agent's worktree. Refuses a worktree with uncommitted changes unless `force`. */
    discard(projectId: string, agentId: string, force?: boolean): Promise<Result<DeveloperAgent>>
    /** Subscribes this window to the agent's terminal and returns its recent output. */
    attach(projectId: string, agentId: string): Promise<Result<AttachResult>>
    detach(projectId: string, agentId: string): Promise<Result<null>>
    /** Sends keystrokes to the agent's terminal (the user typing into the Claude Code session). */
    write(projectId: string, agentId: string, data: string): Promise<Result<null>>
    resize(projectId: string, agentId: string, cols: number, rows: number): Promise<Result<null>>
    summary(): Promise<Result<AgentSummary>>
  }
  /** Terminal output for agents this window attached to. Returns an unsubscribe function. */
  onTerminalData(listener: (event: TerminalEvent) => void): () => void
  /** Subscribes to main-process events. Returns an unsubscribe function. */
  onEvent(listener: (event: AppEvent) => void): () => void
}
