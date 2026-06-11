# Architecture — Daily Command Center

A standalone Express app serving a vanilla-JS single-page dashboard. One Node
process, no build step. Runs locally (`http://localhost:8090`, local Postgres)
and in production (Render + Supabase Postgres, auto-deploy from `main`).

## Layout

`server.js` is the HTTP layer: middleware, auth, and route handlers (being
split into `routes/` modules — see that folder). Domain logic lives in store
modules at the repo root: `db.js` (block CRUD — every entity is a "block" with
type, parent, JSONB properties), `auth.js` (users/workspaces), `slot-store.js`
(rewards/gamification), `social-store.js`, `punishment-store.js`,
`vault-store.js` + `sync-manager.js` (git-backed memory vault),
`evaluation/` (task scoring). `pg-schema.js` creates/patches the schema at
boot; `pg-pool.js` is the shared connection pool.

The frontend is `index.html` plus ~55 modules under `public/js/`, loaded as
plain script tags. `boot.js` fetches state in parallel, `state.js` normalizes
it into globals, feature modules read/write those globals and call `/api/*`.
`block-store.js` keeps a localStorage fallback for offline resilience.

## Auth: three ways into the API

Every request passes the gate middleware in `server.js`, which admits a
request if any of the following holds:

1. **Session (human users).** `express-session` cookie (`dcc_session`,
   httpOnly, sameSite=lax, secure in prod), stored in Postgres via
   `connect-pg-simple`. Created by `/api/auth/login` (bcrypt against `users`)
   or Clerk OAuth sync (`/api/auth/clerk-sync`). `SESSION_SECRET` is required
   in production. Each user gets a workspace (`ws-<userId>`); all queries are
   scoped by `req.workspaceId`, which is the isolation boundary.

2. **Service bearer token (agents/automations).** Endpoints listed in
   `DCC_ENDPOINTS` (quick-task, day-state ingest, refresh, etc.) accept
   `Authorization: Bearer <token>` checked by `hasDccToken()` /
   `hasSweepWriteToken()`. Tokens come from the `service_tokens` table
   (rotatable, revocable — see `token-store.js`) with the
   `SECRET_DCC_TOKEN` / `SECRET_PA_TOKEN` / `SECRET_SWEEP_SUITE_TOKEN` env
   values still honored as fallbacks. Sweep Suite may also POST blocks of
   kind `sweep_suite_task` with its token; identity attaches via
   `attachSweepServiceAuth()`.

3. **Localhost trust (dev only).** `trustLocalhost()` admits 127.0.0.1
   sockets only when `NODE_ENV !== "production"`. On Render every request
   arrives via a local reverse proxy, so localhost is deliberately NOT
   trusted there.

Public, unauthenticated surfaces: `AUTH_PUBLIC` routes (login, health,
auth endpoints, gcal callback) and share routes (`/todo/:token`,
`/pet/:slug`, `/api/public/*`). `/admin` additionally requires
`requireAdmin` (username allowlist).

## Request flow

gate middleware (auth) → route handler (in `server.js` or `routes/`) →
store module → Postgres. Errors that escape a handler hit the global error
middleware at the bottom of `server.js`: logged with stack server-side,
generic message to the client in production.

## Operational notes

`npm start` runs schema patch then server. `npm test` runs the `node --test`
suite. `npm run ship` is the only sanctioned path to production (sync branch
→ PR → merge → Render auto-deploy). The deploy workflow in
`.github/workflows/deploy.yml` blocks DB-risky changes unless acknowledged
with `[migration-ok]`. The vault repo is cloned fresh on each Render cold
boot since the filesystem is ephemeral.
