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
    history: 'teamLead:history'
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
  activity: {
    list: 'activity:list'
  },
  /** Main -> renderer push channel (one fixed channel; payloads are validated). */
  events: {
    app: 'events:app'
  }
} as const
