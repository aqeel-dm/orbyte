import type { Project, PickDirectoryResult, RegisterProjectInput } from '../schemas/project'
import type { Result } from './result'

/** The entire surface exposed to the renderer as `window.orbyte`. */
export interface OrbyteApi {
  projects: {
    list(): Promise<Result<Project[]>>
    pickDirectory(): Promise<Result<PickDirectoryResult>>
    register(input: RegisterProjectInput): Promise<Result<Project>>
    remove(id: string): Promise<Result<null>>
  }
}
