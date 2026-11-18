# Git workflow rules

- Make small, focused commits with a clear message. Use a branch per phase or feature; do not work on `main` for multi-step phases.
- Commit and push only when asked.
- Never commit `.claude/settings.local.json`, `CLAUDE.local.md`, `.env*`, secrets, `node_modules/` or `out/`.
- Do not force-push, rewrite history, or reset without being asked.
- Include migration SQL and `drizzle/meta` in the same commit as the schema change.
- Run `pnpm typecheck` and `pnpm test` before committing, and say so if either fails.
- Orbyte itself must not run `git init`, change config, or commit in a user's registered repository without explicit authorization.
