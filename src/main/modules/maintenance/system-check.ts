import type { SystemCheck } from '@shared/schemas/system'

/**
 * What Orbyte needs from this computer. It looks, never installs or changes anything. Not checked: whether
 * Claude Code is signed in, because that can only be tested by making a request on your account.
 */
export async function checkSystem(deps: {
  gitVersion: () => Promise<string | null>
  resolveClaude: () => string | null
  claudeVersion: () => Promise<string | null>
  secureStorageAvailable: () => boolean
}): Promise<SystemCheck> {
  const [git, claudePath] = [await deps.gitVersion().catch(() => null), deps.resolveClaude()]
  const claudeVersion = claudePath ? await deps.claudeVersion().catch(() => null) : null
  return {
    items: [
      git
        ? { id: 'git', ok: true, detail: git, help: null }
        : { id: 'git', ok: false, detail: 'Not found', help: 'Install Git (2.30 or newer) and make sure it is on your PATH. Developer agents work in git worktrees.' },
      claudePath
        ? { id: 'claude', ok: true, detail: claudeVersion ?? 'Found', help: null }
        : { id: 'claude', ok: false, detail: 'Not found', help: 'Install Claude Code and make sure `claude` is on your PATH. Then run `claude` once in a terminal to sign in; Orbyte reuses that login.' },
      deps.secureStorageAvailable()
        ? { id: 'secureStorage', ok: true, detail: 'Available', help: null }
        : { id: 'secureStorage', ok: false, detail: 'Unavailable', help: 'Orbyte protects approvals with a key kept in your operating system\'s secure storage. Without it, approvals cannot be recorded, so agents cannot be authorized to execute.' }
    ]
  }
}
