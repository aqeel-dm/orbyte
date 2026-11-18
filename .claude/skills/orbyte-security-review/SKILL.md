---
name: orbyte-security-review
description: Security review of Orbyte changes to Electron config, preload, IPC, filesystem, git, or process handling. Use when those areas change or when asked for a security review of Orbyte.
---

# Orbyte security review

1. Determine scope with `git status` / `git diff` (or the files named). Read-only; do not modify files.
2. Delegate to the `security-reviewer` agent with the changed files. Do not pass your own conclusions.
3. Run a quick mechanical sweep yourself and include the results:
   - `grep -rnE "nodeIntegration|contextIsolation|sandbox|webSecurity" src/main`
   - `grep -rnE "ipcMain\.|ipcRenderer\." src` (only `handle.ts` may call `ipcMain.handle`; only the preload may use `ipcRenderer`)
   - `grep -rnE "exec\(|execSync|shell: *true|child_process" src`
   - `grep -rnE "openExternal|will-navigate|setWindowOpenHandler" src/main`
4. Check `docs/SECURITY.md` is still accurate: protections claimed as code-enforced must exist; new gaps must be listed.
5. Report findings by severity, state what is enforced by code versus only instructed, and what was not verified. Do not apply fixes unless asked.
