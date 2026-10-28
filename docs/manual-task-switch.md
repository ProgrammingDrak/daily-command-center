# Manual task switching

The initial itinerary-dock implementation (PR434) is superseded by [Working Queue](working-queue.md). Its session safety policy, additive rotation storage and pet check-back behavior are reused through the shared conversation coordinator. There is one canonical foreground timer and command API for UI and MCP.

The old `/api/work-rotation` write route returns 410 so an old client must reload. The former `scripts/verify-work-rotation.mjs` command forwards to the new Working Queue browser harness. Existing rotation metadata is adopted additively; this is not a destructive migration.
