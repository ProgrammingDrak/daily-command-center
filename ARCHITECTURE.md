# Architecture — Daily Command Center

A standalone Express app serving a vanilla-JS single-page dashboard. One Node
process, no build step. Runs locally (`http://localhost:8090`, local Postgres)
and in production (Railway + Postgres, auto-deploy from `main`; migrated off Render 2026-06-26).

## Layout

`server.js` is the HTTP layer: middleware, auth, and route handlers (being
split into `routes/` modules — see that folder). Domain logic lives in store
modules at the repo root: `db.js` (block CRUD — every entity is a "block" with
type, parent, JSONB properties), `auth.js` (users/workspaces), `slot-store.js`
(rewards/gamification), `social-store.js`, `punishment-store.js`,
`vault-store.js` + `sync-manager.js` (git-backed memory vault),
`budget-store.js` (Budget Tank — see below), `evaluation/` (task scoring).
`pg-schema.js` creates/patches the schema at boot; `pg-pool.js` is the shared
connection pool.

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
   sockets only when `NODE_ENV !== "production"`. On Railway every request
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
→ PR → merge → Railway auto-deploy). The deploy workflow in
`.github/workflows/deploy.yml` blocks DB-risky changes unless acknowledged
with `[migration-ok]`. The vault repo is cloned fresh on each Railway cold
boot since the filesystem is ephemeral.

## Frontend conventions (2026-07-04 overhaul)

- **Mobile boundary is 760px** — matches `mobile-shell.js` `MOBILE_QUERY` and the
  touch-target block in `dashboard.css`. New responsive rules use 480/760/1024,
  not new ad-hoc breakpoints.
- **Shared frontend core**: common helpers (escape, fetch wrapper, toast, dates,
  badges, modal/sheet factory) live in `public/js/core.js` on the `window.DCC`
  namespace, loaded FIRST in index.html. Never reimplement these per tab —
  follow the `urgency.js` single-source pattern.
- **Boy-scout CSS tokens**: any PR touching a CSS block converts that block's
  hard-coded sizes to the tokens in `public/css/tokens.css` (once it lands).

## Budget Tank (`budget-store.js`, `routes/budget.js`, `public/js/budget.js`)

A priority-ordered spending wishlist wired to the slot economy, rendered as a
fish tank. Key invariants:

- **Tank blocks ARE `slot_rewards` rows** (`kind='bank_gated'`) carrying additive
  `tank_*` columns — the same row is a slot-machine objective and a tank block,
  so there is one economy with two claim surfaces. No parallel table.
- **`tank_unlock_cents` ≠ `unlock_threshold_cents`.** The cumulative bottom-up
  waterline gate lives in its own column, recomputed server-side
  (`recomputeTankThresholds`) inside every tank mutation. `reserveCostCents()`
  debits `max(value_cents, unlock_threshold_cents)`, so storing the cumulative
  sum in `unlock_threshold_cents` would make a claim debit the whole stack.
  `value_cents` stays the price a claim debits. Never conflate them.
- **Capacity model**: the whole tank = last period's income (stated in the
  "Income from last month" field → `income_cents`, capacity_source
  `last_income`, the default; `prior_period_banked` auto-derives it from the
  bank build, `fixed` is a set number). Necessities are the submerged reef at
  the bottom, proportional to their dollar total and always covered. The
  **discretionary budget** the reward blocks fill = `income − necessities`
  (`usage.capacity_cents`). Stated income / fixed resolve live (editing income
  resizes the current tank immediately); prior_period_banked uses the capacity
  stamped at rollover so it can't drift mid-period.
- **Waterline is monotonic within a period.** It is a ledger SUM (positive
  `slot_spins` bank deltas + `budget_conversions.cents` this period), not the
  spendable balance, and it fills only the discretionary zone above the reef.
  Claims and punishments debit `bank_balance_cents` but never lower the
  waterline — hence the real "unlocked but reserve short" state.
- **Money Changer conversions live in `budget_conversions`, never `slot_spins`.**
  They raise the tank waterline but must stay out of `getBankUsage` so Bank
  Builder pacing/shield/head-start are never contaminated (regression-tested).
- **Goal unification**: an active monthly tank drives the Bank Builder
  `monthly_goal_cents` (= capacity = last period's build) via
  `tankDrivenGoalCents`; `budget_tank.goal_mode='manual'` opts out.
- **Rollover is lazy** (no cron): a period-key mismatch flags `rollover_due`;
  the user picks carry (unhit one-shots sink to the bottom) or fresh. The sweep
  invests `min(leftover, spendable)` into the append-only `budget_investments`
  ledger (`UNIQUE(workspace, period)` = idempotent) and drops a real "Transfer
  $X to brokerage" task on today via `blockDB.createBlock`.
- Config (necessities, income, period, `cents_per_point`, `current_period`)
  lives in `slot_accounts.settings.budget_tank`. Mutations broadcast
  `slot-changed` so both the tank and the slots tab refresh.
