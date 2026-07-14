# server/src/modules/AGENTS.md

Each feature is a Fastify plugin (`FastifyPluginAsync`) registered in `index.ts`.

## Adding a new module

1. Create `src/modules/<name>/routes.ts` — Fastify plugin, owns all routes for this domain
2. Create `src/modules/<name>/service.ts` — business logic only, no route handling
3. Create `src/modules/<name>/repository.ts` — DB queries, always scoped by `workspace_id`
4. Add one import + one array entry in `src/modules/index.ts`

No auto-discovery — if it's not in `index.ts`, it does not load.

## Hard rules

- Every repository query **must** filter by `workspace_id` — no exceptions
- Business logic belongs in the service, never in route handlers
- A module imports only from: its own files · `@devdigest/shared` · `../../platform/container`
- Adding a module that uses an already-existing table does not require a new migration

## Currently registered (L01)

`agents` · `repos` · `pulls` · `reviews` · `repo-intel` · `settings` · `polling` · `workspace`

## Currently registered (L04)

`blast`

L02–L03 and L05–L08 modules: tables exist in the schema, modules not yet registered.

## See also

- [../../AGENTS.md](../../AGENTS.md) — server conventions
- [../../vendor/shared/AGENTS.md](../../vendor/shared/AGENTS.md) — contract layer
