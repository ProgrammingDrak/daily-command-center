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

## Evening Glymphatic Daily

The evening automation should run the `glymphatic` skill in `daily` mode. It
depends on the `claude-brain` checkout, the DCC checkout, connector access for
daily evidence, and git/shell access for verification and syncing.
