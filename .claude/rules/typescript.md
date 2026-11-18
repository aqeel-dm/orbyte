---
paths:
  - "**/*.ts"
  - "**/*.tsx"
---

# TypeScript rules

- Strict mode with `noUncheckedIndexedAccess` is on. Do not turn options off to silence errors. Avoid `any` and non-null `!` (the single `getElementById('root')!` in `main.tsx` is the accepted exception).
- Derive types from Zod schemas with `z.infer`. Validate at trust boundaries: IPC input, AI output, external data.
- Use `Result` / `ok` / `fail` / `AppError` from `src/shared/types/result.ts`. Throw `AppError(code, message)` for expected failures; `handle()` converts it.
- Imports: `@shared/*` for shared code (main, renderer, tests), `@/*` for the renderer. TypeScript 7 has no `baseUrl`; keep `paths` relative (`./src/...`). Mirror new aliases in `tsconfig.node.json`, `tsconfig.web.json`, `electron.vite.config.ts` and `vitest.config.ts`.
- Main is CommonJS (no `"type": "module"` in `package.json`); the preload is a single CJS file.
- Do not block the main-process event loop with long synchronous work. better-sqlite3 calls are synchronous: keep them short.
- Run `pnpm typecheck` before declaring work done.
