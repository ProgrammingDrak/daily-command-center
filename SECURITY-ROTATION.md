# Security: untrack the leaked DB + rotate the exposed Google credentials

`data/blocks.db` was committed to git and contains live secrets:
- Google OAuth **client secret** + **refresh token** (ongoing Calendar access)
- the `drake` bcrypt password hash

Untracking the file stops *future* exposure, but **anyone who already has the repo
history still has the old token** until you rotate it. So both steps below matter.

---

## 1. Untrack the file  (your terminal — 2 lines)

The agent sandbox can't acquire git's index lock on the mounted volume, so run this
locally from the repo root:

```bash
git rm --cached data/blocks.db
git commit -m "Stop tracking legacy data/blocks.db (held live secrets)"
```

`.gitignore` already has `data/blocks.db`, so it won't be re-added. The file stays
on disk; it's just no longer tracked. (The runtime uses Postgres, not this file, so
nothing breaks.)

> Optional, heavier: to scrub it from *history* too, use `git filter-repo
> --path data/blocks.db --invert-paths` and force-push. Not required once the
> secret below is rotated — rotation makes the historical copy worthless.

## 2. Rotate the Google OAuth client secret  (browser — Google Cloud Console)

1. Google Cloud Console → **APIs & Services → Credentials**.
2. Open the OAuth 2.0 Client ID `185411658007-…apps.googleusercontent.com`
   (project `scenic-handler-492111-s9`).
3. **Add secret** (or "Reset secret") → copy the **new** client secret.
4. After every consumer has the new secret (step 4), delete the old secret.

## 3. Revoke the leaked refresh token  (browser)

- Go to <https://myaccount.google.com/permissions>, find this app, **Remove access**.
  That invalidates the leaked `1//012PZe…` refresh token immediately.
- You'll re-consent once (the "Connect Google" button in the DCC) to mint a fresh
  token. If your machines point `DATABASE_URL` at Supabase, you only do this once
  and every machine is covered.

## 4. Put the new secret where the app reads it

- **Local:** update `GOOGLE_CLIENT_SECRET` in `.env` (and your off-git secret store
  so new machines get it via `BOOTSTRAP.md`).
- **Production (Render):** dashboard → `daily-command-center` service → Environment
  → set `GOOGLE_CLIENT_SECRET` to the new value → save (triggers a redeploy).

## 5. While you're in there — two related hardening items

- **Reset the `SECRET_PA_TOKEN`** (the bearer token for `/api/dcc/quick-task`) to a
  long random string and store it off-git. Generate one with:
  `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
- **Change `clever123`** — it's a weak admin password. Update `SEED_PASSWORD`
  locally + in Render, and the `drake` user's password.

## Verify

- `git ls-files data/blocks.db` returns nothing (untracked).
- Old Google token no longer works; "Connect Google" mints a new one.
- DCC calendar still loads after the new secret is in both `.env` and Render.
