import type { DiscoveryResult } from '../schemas/onboarding'
import type { ListProjectsInput, PickDirectoryResult, Project, RegisterProjectInput } from '../schemas/project'
import type { AppEvent, ChatMessage, SendMessageResult } from '../schemas/team-lead'
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
  /** Subscribes to main-process events. Returns an unsubscribe function. */
  onEvent(listener: (event: AppEvent) => void): () => void
}
