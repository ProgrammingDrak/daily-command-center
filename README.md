# Vault

Drake's long-term memory for the Daily Command Center.

This is an **orphan branch** of `programmingdrak/daily-command-center` — it shares no history with `main` and contains only markdown nodes (tasks, meals, meetings, workouts, journal entries, creative work, daily hubs, tags). DCC's code lives on `main`. This branch is managed by DCC's `SyncManager` and (optionally) synced from Obsidian via the Obsidian Git plugin.

## Layout

```
nodes/
  tasks/{YYYY-MM-DD}-{slug}.md
  meals/{YYYY-MM-DD}-{slug}.md
  meetings/{YYYY-MM-DD}-{slug}.md
  workouts/{YYYY-MM-DD}-{slug}.md
  journal/{YYYY-MM-DD}-{slug}.md
  creative/{projects,places,characters,stories,items}/{slug}.md
daily/{YYYY-MM-DD}.md     -- daily hub node; every consolidated node backlinks here
tags/{slug}.md            -- tags are first-class nodes
conflicts/                -- concurrent-edit losers land here (local wins)
```

## Writers

- **DCC server** (Railway) — commits batches every ~30s, pushes every ~60s
- **You, via Obsidian** — phone/desktop Obsidian Git plugin configured to track this branch

Conflicts are not auto-merged; both copies are preserved and DCC surfaces them.
