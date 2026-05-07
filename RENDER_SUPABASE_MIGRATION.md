# Render + Supabase Migration

This repo is ready to run on Render as a Node web service with Supabase as the Postgres backend.

Current Supabase project:

- Name: `daily-command-center`
- Ref: `zcxyeeeoczfvxuyajrkr`
- Region: `us-east-1`
- Pooler host: `aws-1-us-east-1.pooler.supabase.com`

## 1. Create the Supabase database

1. Create a Supabase project.
2. In Supabase, open **Connect** and copy the **Session pooler** connection string for application traffic. Use the direct connection only if the hosting network supports IPv6.
3. Keep the database password private. This string becomes `DATABASE_URL` in Render.

## 2. Move existing data

From a machine that can reach both databases:

```bash
pg_dump "$RAILWAY_DATABASE_URL" --no-owner --no-acl > backups/railway-$(date +%F-%H%M).sql
psql "$SUPABASE_DATABASE_URL" < backups/railway-YYYY-MM-DD-HHMM.sql
```

If Railway is already unavailable but `data/blocks.db` is current, initialize Supabase and migrate the SQLite snapshot:

```bash
DATABASE_URL="$SUPABASE_DATABASE_URL" npm run schema
DATABASE_URL="$SUPABASE_DATABASE_URL" npm run migrate-data
```

## 3. Create the Render service

1. Connect this GitHub repo to Render.
2. Use the root `render.yaml` blueprint.
3. Set the secret environment variables that are marked `sync: false`:
   - `DATABASE_URL`: Supabase Postgres connection string.
   - `SEED_USERNAME` and `SEED_PASSWORD`: first production login, if no user exists yet.
   - `SECRET_PA_TOKEN`: token for PA ingest endpoints.
   - `VAULT_REPO_URL` and `VAULT_GITHUB_PAT`: optional vault sync.
   - `APP_URL`: optional. Render automatically provides `RENDER_EXTERNAL_URL`, but set `APP_URL` if you use a custom domain.
   - `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`: optional Google Calendar sync fallback if OAuth credentials are not already stored in Postgres.

Render generates `SESSION_SECRET` automatically. Do not overwrite it unless rotating sessions intentionally.

## 4. Google Calendar redirect

After Render gives you the production URL, set the OAuth redirect URI in Google Cloud to:

```text
https://YOUR-RENDER-SERVICE.onrender.com/api/gcal/callback
```

Use that same URL for `GOOGLE_REDIRECT_URI` on Render.

## 5. Deployment behavior

Render runs:

```bash
npm ci
npm run start:render
```

`start:render` runs the idempotent Postgres schema bootstrap before starting the server. Health checks hit `/api/health`, which verifies database connectivity.
