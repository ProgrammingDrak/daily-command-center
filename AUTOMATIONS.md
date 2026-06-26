# Automations

## Morning Sweep Suite

Canonical readiness command:

```sh
npm run sweep:check
```

The command runs the executable Sweep Suite baseline from
`claude-brain/plugins/local/sweep-suite/scripts/sweep_suite_check.py`. It first
looks for `SWEEP_SUITE_ROOT`, then `CLAUDE_BRAIN_ROOT`, then nearby Codex
worktrees and the local portable brain path.

The scheduled Morning Sweep Suite automation is a connector-driven Codex
workflow, not a direct script-only cron job. The readiness command exists so
worktree/cloud runs have a deterministic preflight entrypoint before they read
live Gmail, Calendar, Slack, and DCC state.

## Daytime Triage Checks

Primary DCC ingest command:

```sh
npm run triage:ingest -- --file packet.json
```

Dry-run:

```sh
npm run triage:ingest -- --file packet.json --dry-run
```

The packet must contain only items that need Drake attention. Each item should
include the original source URL, an urgency score, a short reason attention is
needed, and a draft URL when the AI was able to prepare a Gmail/Slack draft.
The DCC endpoint is:

```sh
POST /api/dcc/triage-check/ingest
```

The local macOS publisher is installed by the `claude-brain` LaunchAgent setup
as `com.drakeshadwell.claude-brain.triage-check`. It runs weekdays at 8:30 AM,
11:30 AM, 2:30 PM, and 4:15 PM, reads pending packets from:

```sh
/Users/drakeshadwell/portable-programming/claude-brain/inbox/triage-checks/pending
```

and logs to:

```sh
/Users/drakeshadwell/portable-programming/claude-brain/logs/triage-check.log
```

No-attention/FYI items should not be published into DCC during the day. They can
be summarized in the end-of-day Glymphatic review.

## Morning Brief Materializer

Primary scheduler: local macOS launchd on Drake's Mac,
`com.drakeshadwell.claude-brain.morning-brief-materializer`, installed by:

```sh
/Users/drakeshadwell/portable-programming/claude-brain/scripts/setup-launchagent.sh install
```

It runs at 7:15 AM local time and logs to:

```sh
/Users/drakeshadwell/portable-programming/claude-brain/logs/morning-brief-materializer.log
```

The local launchd wrapper defaults to
`https://daily-command-center-production-1d04.up.railway.app`, the production DCC
on Railway (migrated off Render 2026-06-26; the old `*-personal.onrender.com`
host is suspended). Override with `DCC_BASE_URL` only when intentionally
targeting a different DCC instance.

Canonical dry-run command:

```sh
npm run brief:materialize -- --source-date YYYY-MM-DD --target-date YYYY-MM-DD
```

Apply command:

```sh
npm run brief:materialize -- --source-date YYYY-MM-DD --target-date YYYY-MM-DD --apply
```

This consumes the prior Brief front-page decisions (`Accept`, `Move`,
`Backlog`, `Drop`) and creates DCC itinerary proposal blocks for accepted or
scheduled items. The DCC Brief is Drake's canonical approval surface; Sweep
Suite remains the intake/triage layer and does not automatically create tasks.
Cowork/Claude scheduled tasks are optional enrichment only; they are not the
scheduler of record for this materializer.

## Evening Glymphatic Daily

The evening automation should run the `glymphatic` skill in `daily` mode. It
depends on the `claude-brain` checkout, the DCC checkout, connector access for
daily evidence, and git/shell access for verification and syncing.

The evening run should publish tomorrow's proposed itinerary to the DCC Brief
front page, not to the itinerary directly. Approval-required cleanup or memory
routing batches should be summarized there so they are visible during Drake's
review instead of remaining only in inbox routing packets.
