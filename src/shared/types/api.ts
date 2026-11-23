import type { DiscoveryResult } from '../schemas/onboarding'
import type { ListProjectsInput, PickDirectoryResult, Project, RegisterProjectInput } from '../schemas/project'
import type { AppEvent, ChatMessage, SendMessageResult } from '../schemas/team-lead'
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
  /** Subscribes to main-process events. Returns an unsubscribe function. */
  onEvent(listener: (event: AppEvent) => void): () => void
}
