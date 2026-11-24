import { homedir } from 'node:os'
import { join } from 'node:path'
import { app, BrowserWindow, dialog, webContents } from 'electron'
import { openDatabase, type DbHandle } from './database/client'
import { inspectRepository } from './modules/git/inspect'
import { ChatRepository } from './modules/agents/team-lead/chat-repository'
import { createSdkRunner } from './modules/agents/team-lead/runner'
import { TeamLeadService } from './modules/agents/team-lead/service'
import { discoverProject } from './modules/projects/discovery'
import { OnboardingService } from './modules/projects/onboarding'
import { ProjectRepository } from './modules/projects/repository'
import { ProjectService } from './modules/projects/service'
import { AgentRepository } from './modules/agents/developers/agent-repository'
import { AgentService } from './modules/agents/developers/agent-service'
import { resolveClaudeBinary } from './modules/agents/developers/claude-binary'
import { createProcessReaper } from './modules/agents/developers/process-reaper'
import { createNodePtyFactory } from './modules/agents/developers/pty-node'
import { TerminalHub } from './modules/agents/developers/terminal-hub'
import { GitWorktrees } from './modules/agents/developers/worktrees'
import { registerAgentHandlers } from './ipc/agents'
import { registerPlanHandlers } from './ipc/plans'
import { registerExecutionHandlers } from './ipc/executions'
import { CompletionService } from './modules/orchestration/completion-service'
import { ExecutionRepository } from './modules/orchestration/execution-repository'
import { ExecutionService } from './modules/orchestration/execution-service'
import { ResultReviewService } from './modules/orchestration/result-review-service'
import { AgentInbox } from './modules/agents/developers/agent-inbox'
import { ApprovalService } from './modules/orchestration/approval-service'
import { PlanRepository } from './modules/orchestration/plan-repository'
import { PlanService } from './modules/orchestration/plan-service'
import { ReviewService } from './modules/orchestration/review-service'
import { setTrustedAppEntry } from './ipc/handle'
import { registerProjectHandlers } from './ipc/projects'
import { registerTaskHandlers } from './ipc/tasks'
import { ProposalRepository } from './modules/orchestration/proposal-repository'
import { ProposalService } from './modules/orchestration/proposal-service'
import { ActivityRepository } from './modules/projects/activity-repository'
import { TaskRepository } from './modules/tasks/repository'
import { TaskService } from './modules/tasks/service'
import { installAppSecurity } from './app/security'
import { createMainWindow, getAppEntryUrl } from './app/window'
import { IPC } from '@shared/constants/ipc'
import type { AppEvent } from '@shared/schemas/team-lead'

let dbHandle: DbHandle | undefined
let teamLeadService: TeamLeadService | undefined
let agentService: AgentService | undefined
let quitting = false

process.on('unhandledRejection', (reason) => console.error('[main] unhandled rejection', reason))

async function bootstrap(): Promise<void> {
  const migrations = app.isPackaged ? join(process.resourcesPath, 'drizzle') : join(app.getAppPath(), 'drizzle')
  dbHandle = openDatabase(join(app.getPath('userData'), 'orbyte.db'), migrations)

  const appEntryUrl = getAppEntryUrl()
  setTrustedAppEntry(appEntryUrl)

  const projectRepo = new ProjectRepository(dbHandle.db)
  // One fixed push channel to the renderer; payloads are validated again in the preload.
  const emit = (event: AppEvent): void => {
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send(IPC.events.app, event)
  }
  const taskRepo = new TaskRepository(dbHandle.db)
  // Stopping an agent when the user cancels or blocks its task: the service is created just below.
  let approvalsRef: { onTaskLeft(taskId: string): void } | undefined
  let completionRef: { onTaskLeft(taskId: string): void } | undefined
  const taskService = new TaskService({
    projects: projectRepo,
    tasks: taskRepo,
    emit,
    // The user moved a task out of active work: stop its agent and drop any standing approval.
    onLeaveActive: (taskId) => {
      agentService?.onTaskLeft(taskId)
      approvalsRef?.onTaskLeft(taskId)
      completionRef?.onTaskLeft(taskId)
    }
  })
  const proposalService = new ProposalService({
    db: dbHandle.db,
    projects: projectRepo,
    tasks: taskRepo,
    proposals: new ProposalRepository(dbHandle.db),
    emit
  })
  const teamLead = (teamLeadService = new TeamLeadService({
    projects: projectRepo,
    chat: new ChatRepository(dbHandle.db),
    runner: createSdkRunner(),
    emit,
    // The project id is bound here, on the server. The model never chooses which project a tool acts on.
    taskToolsFor: (projectId) => ({
      listTasks: () => taskService.digest(projectId),
      propose: (input) => proposalService.record(projectId, input)
    })
  }))
  // Plans, the Team Lead's advice on them, and the user's approvals (the execution gate).
  const planRepo = new PlanRepository(dbHandle.db)
  const agentRepo = new AgentRepository(dbHandle.db)
  let reviews: ReviewService | undefined
  const planService = new PlanService({
    agents: agentRepo,
    taskRepo,
    tasks: taskService,
    plans: planRepo,
    emit,
    // A captured plan is sent to the Team Lead for advice. This never approves anything.
    onPlanSubmitted: (plan) => reviews?.reviewAutomatically(plan)
  })
  reviews = new ReviewService({ projects: projectRepo, taskRepo, plans: planRepo, teamLead, emit })
  const execRepo = new ExecutionRepository(dbHandle.db)
  const approvals = new ApprovalService({
    db: dbHandle.db,
    results: execRepo,
    projects: projectRepo,
    taskRepo,
    tasks: taskService,
    agents: agentRepo,
    plans: planRepo,
    emit,
    reviewInProgress: (planId) => reviews?.isInProgress(planId) ?? false
  })
  approvalsRef = approvals
  const onboarding = new OnboardingService({ projects: projectRepo, teamLead, discover: discoverProject, emit })
  onboarding.recoverInterrupted()

  const projectService = new ProjectService({
    repo: projectRepo,
    inspect: inspectRepository,
    discover: discoverProject,
    // An archived project must have no live work: stop its agents.
    onArchive: (projectId) => agentService?.stopAllForProject(projectId)
  })
  // Terminal output goes only to windows that attached to that agent.
  const hub = new TerminalHub((windowId, event) => webContents.fromId(windowId)?.send(IPC.events.terminal, event))
  app.on('web-contents-created', (_e, contents) => contents.once('destroyed', () => hub.detachAll(contents.id)))
  const worktrees = new GitWorktrees()
  let execution: ExecutionService | undefined
  const agents = (agentService = new AgentService({
    projects: projectRepo,
    taskRepo,
    tasks: taskService,
    agents: agentRepo,
    worktrees,
    pty: createNodePtyFactory(),
    hub,
    resolveClaude: () => resolveClaudeBinary({ env: process.env, home: homedir() }),
    reaper: createProcessReaper(),
    inbox: new AgentInbox(join(app.getPath('userData'), 'plan-inbox')),
    // Claude Code starts this script (Electron run as plain Node) to give the agent its submit_plan tool.
    agentServer: { command: process.execPath, scriptPath: join(__dirname, 'agent-server.js') },
    onPlan: (agentId, plan) => void planService.ingest(agentId, plan),
    onProgress: (agentId, messages) => execution?.onProgress(agentId, messages),
    onResult: async (agentId, result) => void (await execution?.onResult(agentId, result)),
    onExecutionAgentEnded: (agent, status) => execution?.onAgentEnded(agent, status),
    env: () => process.env,
    worktreeRoot: join(app.getPath('userData'), 'worktrees'),
    logDir: join(app.getPath('userData'), 'terminal-logs'),
    emit
  }))
  await agents.recoverInterrupted()

  const resultReviews = new ResultReviewService({ projects: projectRepo, taskRepo, exec: execRepo, plans: planRepo, agents: agentRepo, worktrees, teamLead, emit })
  execution = new ExecutionService({
    projects: projectRepo, taskRepo, tasks: taskService, agents: agentRepo, agentService: agents, approvals, plans: planRepo,
    exec: execRepo, worktrees, emit,
    // A stored result is sent to the Team Lead for advice. This never accepts anything.
    onResultSubmitted: (result) => resultReviews.reviewAutomatically(result)
  })
  const completion = new CompletionService({
    projects: projectRepo, taskRepo, tasks: taskService, exec: execRepo, agents: agentRepo, worktrees, emit,
    reviewInProgress: (resultId) => resultReviews.isInProgress(resultId)
  })
  completionRef = completion
  execution.recoverInterrupted()

  registerAgentHandlers({ agents })
  registerPlanHandlers({ approvals, reviews })
  registerExecutionHandlers({ execution, completion, resultReviews })
  registerTaskHandlers({ tasks: taskService, proposals: proposalService, activity: new ActivityRepository(dbHandle.db), projects: projectService })
  registerProjectHandlers({
    projects: projectService,
    onboarding,
    teamLead,
    emit
  })
  installAppSecurity(appEntryUrl)
  createMainWindow()
}

// Single instance: one app owns the database and (later) all agent processes.
if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win?.isMinimized()) win.restore()
    win?.focus()
  })
  void app.whenReady().then(bootstrap).catch((err) => {
    console.error('[main] startup failed', err)
    dialog.showErrorBox('Orbyte could not start', 'The database or application failed to initialize. See the application log for details.')
    app.exit(1)
  })
  // Closing the window must not end the app on macOS (agents keep running).
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })
  // Abort in-flight Team Lead turns (and their subprocesses) before the database closes.
  app.on('before-quit', (event) => {
    if (quitting) return
    quitting = true
    event.preventDefault()
    // Stop Team Lead turns and developer agent processes before the database closes.
    void Promise.allSettled([teamLeadService?.shutdown(), agentService?.shutdown()])
      .catch((err) => console.error('[main] shutdown failed', err))
      .finally(() => {
        dbHandle?.close()
        app.quit()
      })
  })
}
