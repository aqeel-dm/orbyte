/** Every IPC channel the renderer may use. Nothing else is exposed. */
export const IPC = {
  projects: {
    list: 'projects:list',
    get: 'projects:get',
    pickDirectory: 'projects:pickDirectory',
    register: 'projects:register',
    archive: 'projects:archive',
    restore: 'projects:restore'
  },
  onboarding: {
    start: 'onboarding:start'
  },
  teamLead: {
    send: 'teamLead:send',
    interrupt: 'teamLead:interrupt',
    history: 'teamLead:history'
  },
  /** Main -> renderer push channel (one fixed channel; payloads are validated). */
  events: {
    app: 'events:app'
  }
} as const
