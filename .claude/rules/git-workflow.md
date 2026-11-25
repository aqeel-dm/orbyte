# Git workflow rules

- Make small, focused commits with a clear message. Implement each task on a new branch cut from an up-to-date `main` and open a pull request to `main` (the user's decision from 2026-11-25; do not merge it yourself). Merging to `main` publishes a release (`.github/workflows/release.yml`). Keep `main` passing `pnpm typecheck` and `pnpm test` at every commit.
- Commit and push only when asked.
- Never commit `.claude/settings.local.json`, `CLAUDE.local.md`, `.env*`, secrets, `node_modules/` or `out/`.
- Do not force-push, rewrite history, or reset without being asked.
- Include migration SQL and `drizzle/meta` in the same commit as the schema change.
- Run `pnpm typecheck` and `pnpm test` before committing, and say so if either fails.
- Orbyte itself must not run `git init`, change config, or commit in a user's registered repository without explicit authorization.
