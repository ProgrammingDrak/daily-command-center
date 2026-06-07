# Clerk Production Setup — Daily Command Center

Status: **development instance working** (local + would work on onrender.com with dev keys).
Production is **blocked on a custom domain** — Clerk production requires DNS records
you can't add to a `*.onrender.com` subdomain, and `clerk deploy` must be run from
an interactive terminal (it refuses to run headlessly).

Legend: **[YOU]** = needs your terminal / browser / dashboard. **[ME]** = I can run/verify it.

Replace `<DOMAIN>` below with your custom domain (a subdomain is fine, e.g. `dcc.shadwell.app`).

---

## 1. Point the app at a custom domain (Render)  **[YOU]**
1. Render dashboard → `daily-command-center` service → **Settings → Custom Domains** → add `<DOMAIN>`.
2. Render shows a CNAME target (`daily-command-center.onrender.com`). Add that CNAME at your DNS provider.
3. Wait for Render to verify and issue TLS (green check).
4. Set env var `APP_URL=https://<DOMAIN>` on the Render service.

## 2. Create the Clerk production instance  **[YOU]** (interactive)
From the repo root:
```bash
clerk deploy
```
- When prompted for the production domain, enter `<DOMAIN>`.
- Clerk prints **DNS records** (CNAMEs for `clerk`, `accounts`, `clkmail`, plus DKIM).
  Add **all** of them at your DNS provider.
- **[ME]** I can then run `clerk deploy status` on a loop and tell you when DNS verifies.

## 3. Google OAuth client for production  **[YOU]** (browser)
Production does **not** use Clerk's shared Google credentials — you supply your own.
1. Google Cloud Console → **APIs & Services → Credentials** → Create **OAuth client ID** → *Web application*.
   - You can reuse the existing project from your Calendar/Gmail integration.
2. **Authorized redirect URI**: copy the exact value Clerk shows in
   *Dashboard → SSO Connections → Google (production)* — it looks like
   `https://clerk.<DOMAIN>/v1/oauth_callback`.
3. Copy the **Client ID** + **Client Secret** → paste into Clerk's Google connection
   (production) and enable it.

## 4. Production keys into Render env  **[YOU]** (or **[ME]** via Render API if you give me a key)
1. Clerk dashboard (production instance) → **API Keys** → copy `pk_live_…` and `sk_live_…`.
2. Render service → **Environment** → set:
   - `CLERK_PUBLISHABLE_KEY=pk_live_…`
   - `CLERK_SECRET_KEY=sk_live_…`
   (`render.yaml` already declares these as `sync:false` placeholders.)

## 5. ⚠️ Pre-link your account in the PRODUCTION database  **[ME, with your OK]**
The link-by-email logic only links a Google login to an existing account **if that
account already has your email set**. I set this on the *local* DB, but the **production
Supabase** `drake` user almost certainly still has `email = NULL` — so your first
production Google sign-in would create a **new empty account** instead of linking.

Before you sign in on production, this one-time update must run against the prod DB:
```sql
UPDATE users SET email = 'official.drakeshadwell@gmail.com', updated_at = now()
WHERE username = 'drake' AND external_id IS NULL;
```
**[ME]** I can run this against the prod `DATABASE_URL` once you say go (it's a prod write,
so I'll confirm first).

## 6. Deploy the code  **[YOU]** approve the merge; **[ME]** can open the PR
The integration lives on branch `feat/social-features` (committed locally).
- Merge `feat/social-features` → `main`. Render auto-deploys `main`.
- On boot, `start:render` runs `pg-schema.js`, which applies the new OAuth columns to
  the production DB (additive, idempotent, safe).

## 7. Verify  **[ME]**
- `clerk deploy status` → production complete, OAuth configured.
- Visit `https://<DOMAIN>/login` → "Continue with Google", no "Development mode" badge,
  your branding on the Google consent screen.
- Sign in with `official.drakeshadwell@gmail.com` → should **link** to the prod `drake`
  account (step 5), not create a duplicate. I'll confirm in the prod DB.

---

### What I can do the moment you're ready
- Run `clerk deploy status` polling after you start `clerk deploy`.
- Run the step-5 prod email pre-link (with confirmation).
- Open the PR to merge `feat/social-features` → `main`.
- Verify the prod DB and live login end-to-end.

### What only you can do
- Acquire/attach the custom domain + add DNS records.
- Run `clerk deploy` (interactive).
- Create the Google OAuth client in Google Cloud Console.
- Set env vars in the Render dashboard (unless you hand me a Render API key).
