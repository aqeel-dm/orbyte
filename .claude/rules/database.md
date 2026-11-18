---
paths:
  - "src/main/database/**"
  - "drizzle/**"
  - "drizzle.config.ts"
  - "src/main/modules/**/repository.ts"
---

# Database rules

- Schema lives in `src/main/database/schema.ts`. After any change run `pnpm db:generate` and commit the generated SQL and `drizzle/meta/*`. Never hand-edit an applied migration; add a new one.
- Migrations run at startup in `openDatabase` (`client.ts`). Keep WAL and `foreign_keys = ON`.
- Only repositories query the database. Services and handlers receive DTOs, not Drizzle rows. Map rows to shared types in the repository.
- Use `db.transaction` when a state change spans rows (for example a record plus its `activity_events` row).
- Record meaningful state transitions and errors as `activity_events`.
- `updated_at` is not maintained automatically. Set it explicitly when you write an update path.
- Deleting a project cascades to `activity_events`. Do not add destructive paths without deciding how the audit trail is kept.
- Do not add tables ahead of their phase. Mark planned tables as Planned in `docs/DATABASE.md`.
