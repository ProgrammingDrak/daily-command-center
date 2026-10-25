# Glasses launch uses full DCC

After physical-glasses feedback, `/glasses` and `/glasses.html` now redirect to the canonical full DCC app at `/`. Existing launch URLs carrying list/view/date parameters also open full DCC. The query string and browser fragment survive the same-origin temporary redirect; canonical DCC interprets its own supported parameters. Old compact-only list/date parameters do not add new full-app navigation semantics.

Authentication and account binding run before the redirect. A signed-out launch retains its original local return destination through existing login recovery, then opens full DCC. No authentication factors, permissions, credentials or task storage change.

Explicit saved compact task links with a nonempty `task` parameter continue to open the existing task detail, including its date and return state. The separate routine link is unchanged. These compatibility paths are not the default launch and are not being extended. Future presentation work should reuse canonical domain/data/actions/permissions.

Refresh or reopen the existing glasses launch bookmark to use the new default. If a saved task-detail URL is open, navigate to `/glasses.html` or `/` to open full DCC. Physical qualification of the change remains for the user; simulated browser checks do not qualify glasses hardware.

## Known parity context

The compact model explicitly excludes legacy seed-only timeline entries and does not materialize unprepared source cards on load; Waiting/source resolution and dateless completion are also limited. These are confirmed differences, not a diagnosis of every task the user reported missing. The immediate default change removes the compact model from ordinary launches without modifying production task data or delaying access to the working full app.
