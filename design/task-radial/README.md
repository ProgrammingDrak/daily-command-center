# Combined task radial

All Change Task actions and Lock/Unlock are direct spokes. Nested tasks retain Promote; scheduled repeats retain Repeat options. Conversion retains its type picker and Back returns to the combined menu. Meeting and carryover actions keep their existing callbacks.

The full circle uses 60px phone targets and 64px desktop targets, captions inside each target, 16px viewport clearance, and center Cancel. The controller preserves focus navigation and restores the opener; scroll/resize dismiss stale placement. Existing non-task fans retain their arc layout.

Validation: 2,877 unit tests passed after rebase onto main e16a9f8, 5 skipped; repository radial walkthrough passed; review-task-circle.cjs passed all 11 callback routes, actual lock/unlock, keyboard activation, touch/repeated opens, 20 edge placements at four widths, non-overlap, Convert/Back, Cancel/outside/Escape/scroll/resize. Fixtures only. Screenshots: radial-390.png and radial-1440.png; structured evidence: radial-qa.json. Run PORT=8317 DCC_REVIEW_TASK_DETAILS=1 node scripts/ui-review-server.mjs, then node scripts/review-task-circle.cjs.

The two supplied Library references could not be inspected: supported consumer-local materialization retry returned HTTP 403 for both. No deployment or production writes.
