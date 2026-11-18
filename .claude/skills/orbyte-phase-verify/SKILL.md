---
name: orbyte-phase-verify
description: Verify an Orbyte phase or change by running typecheck, tests and build and checking acceptance criteria honestly. Use before declaring a phase or feature complete.
---

# Orbyte phase verification

1. Identify the phase and its acceptance criteria in `docs/ROADMAP.md` (and the brief the user gave). If the target phase was not authorized by the user, stop and say so.
2. Run, in order, and record real output: `pnpm typecheck`, `pnpm test`, `pnpm build`. Never summarize a failure as success. Report failing test names and errors.
3. For each acceptance criterion, state: verified (how), partially verified, or not verified. Prefer evidence from running the app (`electron . --remote-debugging-port=9333` after build, DevTools protocol) over reading code. Native dialogs and UI that were not exercised are "not verified".
4. Check that nothing outside the phase's scope was added (new tables, dependencies, modules) and that `docs/` and `CLAUDE.md` status text match reality.
5. Output a table: criterion, status, evidence. Then list placeholders, known gaps, and untested areas. Do not mark a phase complete in docs unless every criterion is verified.
