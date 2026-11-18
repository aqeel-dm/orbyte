/** Every IPC channel the renderer may invoke. Nothing else is exposed. */
export const IPC = {
  projects: {
    list: 'projects:list',
    pickDirectory: 'projects:pickDirectory',
    register: 'projects:register',
    remove: 'projects:remove'
  }
} as const
