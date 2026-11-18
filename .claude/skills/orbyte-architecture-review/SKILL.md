---
name: orbyte-architecture-review
description: Review recent Orbyte changes against layer boundaries, module structure, phase scope, and docs accuracy. Use before committing structural changes or when asked for an architecture review.
---

# Orbyte architecture review

1. Determine scope: `git status` and `git diff` (or the files the user names). Read-only; do not modify files.
2. Delegate to the `architecture-reviewer` agent with the changed file list and a one-line summary of the intent. Do not pass your own conclusions.
3. Independently spot-check two claims from the report against source before relaying them.
4. Compare `docs/ARCHITECTURE.md`, `docs/DATABASE.md`, `docs/IPC-CONTRACTS.md` and `docs/ROADMAP.md` with the change; list any doc that is now stale or describes planned work as implemented.
5. Report: findings by severity, doc drift, and what was not checked. Do not apply fixes unless asked.
