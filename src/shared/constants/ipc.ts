/** Every IPC channel the renderer may use. Nothing else is exposed. */
export const IPC = {
  projects: {
    list: 'projects:list',
    get: 'projects:get',
    pickDirectory: 'projects:pickDirectory',
    register: 'projects:register',
    archive: 'projects:archive',
    restore: 'projects:restore',
    setTrust: 'projects:setTrust',
    discover: 'projects:discover'
  },
  onboarding: {
    start: 'onboarding:start'
  },
  teamLead: {
    send: 'teamLead:send',
    interrupt: 'teamLead:interrupt',
    history: 'teamLead:history',
    summary: 'teamLead:summary'
  },
  tasks: {
    list: 'tasks:list',
    create: 'tasks:create',
    update: 'tasks:update',
    transition: 'tasks:transition',
    summary: 'tasks:summary'
  },
  proposals: {
    list: 'proposals:list',
    approve: 'proposals:approve',
    dismiss: 'proposals:dismiss'
  },
  decisions: {
    list: 'decisions:list'
  },
  activity: {
    list: 'activity:list',
    listRecent: 'activity:listRecent'
  },
  agents: {
    list: 'agents:list',
    start: 'agents:start',
    stop: 'agents:stop',
    discard: 'agents:discard',
    attach: 'agents:attach',
    detach: 'agents:detach',
    write: 'agents:write',
    resize: 'agents:resize',
    summary: 'agents:summary'
  },
  plans: {
    get: 'plans:get',
    approve: 'plans:approve',
    reject: 'plans:reject',
    revoke: 'plans:revoke',
    requestReview: 'plans:requestReview'
  },
  executions: {
    start: 'executions:start',
    get: 'executions:get',
    accept: 'executions:accept',
    requestChanges: 'executions:requestChanges',
    requestReview: 'executions:requestReview',
    changes: 'executions:changes',
    runTests: 'executions:runTests',
    testRuns: 'executions:testRuns'
  },
  system: { check: 'system:check' },
  updates: { status: 'updates:status', check: 'updates:check', openDownload: 'updates:openDownload' },
  usage: { get: 'usage:get' },
  maintenance: {
    scan: 'maintenance:scan',
    cleanOrphans: 'maintenance:cleanOrphans',
    backupDatabase: 'maintenance:backupDatabase'
  },
  /** Main -> renderer push channel (one fixed channel; payloads are validated). */
  events: {
    app: 'events:app',
    /** High-volume terminal output; delivered only to windows that attached to that agent. */
    terminal: 'events:terminal'
  }
} as const
