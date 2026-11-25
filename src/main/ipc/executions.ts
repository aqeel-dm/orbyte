import { IPC } from '@shared/constants/ipc'
import { acceptResultInputSchema, requestChangesInputSchema, requestResultReviewInputSchema, resultChangesInputSchema, runTestsInputSchema, startExecutionInputSchema, testRunsInputSchema } from '@shared/schemas/execution'
import { planTaskInputSchema } from '@shared/schemas/plan'
import type { CompletionService } from '../modules/orchestration/completion-service'
import type { ExecutionService } from '../modules/orchestration/execution-service'
import type { TestRunService } from '../modules/orchestration/test-run-service'
import type { ResultReviewService } from '../modules/orchestration/result-review-service'
import { handle } from './handle'

/**
 * What the renderer may do with executions. `start` runs the approval gate in main (it refuses without a
 * valid stored approval); accepting runs the completion gate. Neither takes a path, command or id of an
 * approval from the renderer. `authorizeExecution`/`authorizeRevision` are not exposed.
 */
export function registerExecutionHandlers(deps: { execution: ExecutionService; completion: CompletionService; resultReviews: ResultReviewService; testRuns: TestRunService }): void {
  const { execution, completion, resultReviews, testRuns } = deps
  handle(IPC.executions.changes, resultChangesInputSchema, ({ projectId, taskId, resultId }) => completion.changes(projectId, taskId, resultId))
  handle(IPC.executions.runTests, runTestsInputSchema, ({ projectId, taskId, resultId }) => testRuns.start(projectId, taskId, resultId))
  handle(IPC.executions.testRuns, testRunsInputSchema, ({ projectId, taskId }) => testRuns.list(projectId, taskId))
  handle(IPC.executions.start, startExecutionInputSchema, ({ projectId, taskId }) => execution.start(projectId, taskId))
  handle(IPC.executions.get, planTaskInputSchema, ({ projectId, taskId }) => completion.bundle(projectId, taskId))
  handle(IPC.executions.accept, acceptResultInputSchema, ({ projectId, taskId, resultId }) => completion.accept(projectId, taskId, resultId))
  handle(IPC.executions.requestChanges, requestChangesInputSchema, ({ projectId, taskId, resultId, feedback }) => execution.requestChanges(projectId, taskId, resultId, feedback))
  handle(IPC.executions.requestReview, requestResultReviewInputSchema, ({ projectId, taskId, resultId }) => {
    resultReviews.request(projectId, taskId, resultId)
    return null
  })
}
