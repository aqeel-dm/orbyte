---
paths:
  - "tests/**"
  - "**/*.test.ts"
---

# Testing rules

- Run tests with `pnpm test`. It runs Vitest under Electron's Node ABI so better-sqlite3 loads. Plain `vitest` or `node` will fail on the native module.
- Use the helpers in `tests/helpers.ts` (`makeService`, `tempDir`). Use real migrations from `drizzle/` against `:memory:` or a temp file. Do not mock the database.
- Use real temp directories and real `git` for git tests. Never run `git init` in a user's directory.
- Test business rules, validation failures and security boundaries (tokens, path checks, approval enforcement, ownership checks), not only the happy path.
- Never fake agent, terminal, test-run or approval success in tests or code.
- Add tests with each new service or rule. Report failing tests honestly; do not skip or delete them to get green.
- Not yet present: Playwright/UI tests and tests for the IPC wrapper and window security. Add them when you touch those areas, and note what is untested.
