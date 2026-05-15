## What changed

- Award completed scheduled tasks by their scored point value instead of always adding one legacy token.
- Migrate old slot balances and spin costs into the point-based system without remultiplying already migrated accounts.
- Value BANK tiles from the monthly goal and preserve payout metadata for highlighting.
- Add winning-cell gold pulsing, BANK coin physics, gold transfer into the piggy bank, and a `+$X.XX` impact label.
- Keep coin effects scoped to the Slots page and remove them when switching tabs.

## Why

Completed tasks were still behaving like one-token awards even though the slot economy had moved to scored task points. BANK tile payouts also needed to reflect the monthly-goal percentage behavior and the new animations needed page-lifecycle cleanup.

## Validation

- `node --check public\js\slots.js`
- `node --check public\js\tabs.js`
- `node --check public\js\schedule.js`
- `node --test slot-scoring.test.js slot-store.test.js evaluation\scoring.test.js`
