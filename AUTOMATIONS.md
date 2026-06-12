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
`https://daily-command-center-personal.onrender.com`, which is the Render
service declared by this repo's `render.yaml`. Override with `DCC_BASE_URL`
only when intentionally targeting a different DCC instance.

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
