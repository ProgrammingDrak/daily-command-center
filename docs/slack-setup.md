# Slack reaction capture: setting up the shared bot

One Slack app serves every DCC user. A reaction is routed to whoever reacted, so
nobody needs their own app, their own bot, or their own tokens. A reactor with no
DCC account is dropped and nothing is written anywhere.

What the reactions do:

| Reaction | Effect |
|---|---|
| 🔖 `:bookmark:` | Creates a task on the reactor's itinerary, then enriches the title and summary from the full thread |
| 👥 `:busts_in_silhouette:` | Creates a Delegated item due for check-in tomorrow |
| ⌛ `:hourglass:` | Stamps the exact start time, to the second |
| ✅ `:white_check_mark:` | Completes it, records actual minutes, awards points, writes a Day Review time entry |

Removing a reaction reverses it, including the points.

## One-time server setup

### 1. Slack app

In the app's settings:

- **OAuth & Permissions → Bot Token Scopes**: `reactions:read`, `users:read`,
  `users:read.email`, `channels:history`, `groups:history`. Install to the
  workspace and copy the bot token (`xoxb-…`).
- **Event Subscriptions → Request URL**: `https://<your-dcc-host>/api/slack/events`.
  The URL verification handshake is signature-checked, so the signing secret has
  to be set on the server before Slack will verify.
- **Event Subscriptions → Subscribe to bot events**: `reaction_added` and
  `reaction_removed`.
- **Basic Information**: copy the signing secret.

### 2. Environment

```
SLACK_SIGNING_SECRET=…            # Basic Information
SLACK_BOT_TOKEN=xoxb-…            # OAuth & Permissions
SLACK_TEAM_ALLOWLIST=T0XXXXXXX    # your workspace's team ID
SLACK_WORKSPACE_HOST=example.slack.com
SLACK_DELEGATE_IMPORT_AFTER=2026-08-18T00:00:00.000Z
ANTHROPIC_API_KEY=…               # optional, for the AI title and summary
```

`SLACK_DELEGATE_IMPORT_AFTER` must be set once to the rollout instant and then
left alone, or old 👥 reactions get imported on every restart. In production the
server refuses to boot with reconciliation enabled and this unset.

**`SLACK_TEAM_ALLOWLIST` unset disables auto-linking entirely.** That is
deliberate. Auto-linking matches a reactor's Slack email to a DCC account, so
without a team allowlist anyone who installed the app in their own workspace could
claim an account by email collision.

### 3. Invite the bot

```
/invite @your-dcc-app
```

in every channel people want to capture from. **This is the one real limitation:
the bot only receives reactions in conversations it belongs to.** There is no
workspace-wide reaction firehose short of Enterprise Grid's Discovery API. DMs and
private channels it has not been invited to are invisible to it.

## What a teammate has to do

Nothing. They sign into the DCC with the email address their Slack account uses,
react 🔖 to a message in a channel the bot is in, and the task appears on their
day. Their Slack identity is linked on that first reaction.

The onboarding tour offers this as one of two optional power-ups, and **Settings →
Setup & integrations** reopens it forever. The wizard checks the three things in
order (is there a shared bot, is your workspace allowlisted, are you linked), tells
them plainly when a step is an admin's job rather than theirs, and has an
"I reacted, check now" button so the link is confirmed rather than assumed.

### When there is no email to match on

Accounts seeded with a password, or created before email was stored, have nothing
to match against. The wizard's "It did not link me" section takes a Slack member ID
instead and records a **claim**: a `slack_identities` row with
`linked_via = 'pending'`.

A claim grants nothing. It is skipped by the reconciliation roster and by
`actorForWorkspace`, so it receives no sweeps and no reaction projections. It
becomes a real link only when a reaction actually arrives from that member ID,
which is the proof of control. That same first reaction also creates its task.

`claimPending` refuses a member ID already linked to another DCC account, and
refuses when Slack exposes an email for that ID which contradicts the claiming
account's email. **Residual risk:** when Slack exposes no email at all, which is
exactly the case this path exists for, the reaction handshake is the only guard
left. Someone who pasted a colleague's member ID and could somehow cause that
colleague to react would capture their reactions. Inside a single trusted
workspace that is proportionate; if this ever ships outside one, replace the claim
with a nonce reaction the wizard names.

## Tiers, and what a personal token adds

| | Bot tier (default) | User tier |
|---|---|---|
| Setup | none | connect your own Slack |
| Channels the bot is in | yes | yes |
| Your DMs and private channels | no | yes |
| `hasmy:` catch-up sweep after downtime | no | yes |
| Reactions posted as you | no, posted as the bot | yes |

`search.messages` is the only Slack method with no bot-token equivalent at all,
which is why the catch-up sweep is user tier only. Bot-tier actors skip it rather
than failing every five minutes.

Setting `SLACK_USER_TOKEN` plus `DRAKE_SLACK_USER_ID` promotes exactly one
identity to user tier. That pair predates the shared bot and remains the env
fallback: it resolves before any database lookup, so an existing single-tenant
deployment keeps behaving exactly as it did.

## Verifying

```bash
curl -s https://<your-dcc-host>/api/health
curl -s -X POST https://<your-dcc-host>/api/dcc/slack-reconcile \
  -H "Authorization: Bearer $SECRET_DCC_TOKEN"
```

The reconcile response reports `actors` (how many identities are linked) plus the
per-pass `bookmarks`, `delegates`, `enriched` and `mirrored` counts.
`{"skipped":"no_actors"}` means nothing is linked yet, which is expected before
anyone has reacted.

The onboarding tour's "Connect Your Stack" step reads
`GET /api/me/integrations` and shows each person their own link status.

## The other power-up: AI triage

The tour's second button is a different animal and the wizard says so. Slack setup
is server-side state this app can finish; triage setup is state on the person's own
machine (a Claude plugin plus `~/.claude/dcc/profiles.json`), so the DCC can only
report the prerequisite it owns and confirm the result.

Its four steps:

1. **Can this account be automated?** `dcc_client.py login` needs a password, and a
   Clerk/Google account has none, so it would 401. The wizard surfaces that before
   they waste time on the rest.
2. **Install the skill bundle** they were sent. Their Gmail/Slack/Calendar
   connectors are their own OAuth inside their own Claude; nothing to authorize here.
3. **Point it at the DCC once**, with the `dcc_client.py login` command rendered
   with their host and username already filled in. Session auth means every write
   is scoped to their user and workspace, which is why this is the recommended path
   and a shared service token is not: a service token carries no owner, so it lands
   on `DCC_SERVICE_USER_ID` regardless of who holds it.
4. **Confirm it reached us.** `GET /api/me` stamps
   `onboarding_state.setup.triageLastSeenAt` when the caller sends a non-Mozilla
   user agent, which `dcc_client.py`'s urllib login does. A heuristic, used only to
   flip a checkmark, never to authorize anything.
