# Full itinerary on the compact display

The glasses entry point is `/glasses.html`. It opens the complete scrollable itinerary, grouped by the saved desktop time blocks. Completed tasks remain inline with a Done label and struck-through title. Completed children are expanded in place on glasses; desktop keeps those children in the parent detail. Both use TaskModel's canonical hierarchy and order.

Five persistent header pills use desktop queue order: Triage, Loose Ends, Waiting, Unscheduled, Whenever. Counts are open roots, except Waiting, whose badge counts overdue check-ins while its list contains all open Waiting items. Loose Ends starts with the desktop's 14-day window; Show older tasks requests the existing bounded all-history endpoint. A failed expansion keeps the confirmed scope label. Truncated results are explicitly identified.

TaskQueues shares Waiting eligibility/cadence, Whenever ordering, source filtering, and saved Unscheduled ordering between desktop and glasses. TimeBlocks shares completed-untimed placement. Completion times use DCC's configured timezone. The existing account-bound bootstrap, task detail, carryover, and completion APIs remain authoritative; no new database or schema is introduced.

Arrow keys move focus; Enter selects. Focusing the card and pressing up/down scrolls it. Back restores the originating row and scroll position. Queue and task selection survive reload in the URL. Automatically selected Today stays automatic across reload/sign-in; explicitly selected dates remain pinned. Completion still requires confirmation and uses the existing durable per-tab retry receipt and canonical server acknowledgement.

## Boundaries

- Dated tasks use the existing completion endpoint. Dateless tasks must first be scheduled in full DCC.
- Waiting and raw source-review details are read-only here; check-in, scheduling, and source-resolution actions remain in full DCC.
- Unlike desktop's Triage loader, glasses does not materialize source tasks on page load. Unprepared source items remain readable in Loose Ends, and Triage explains this difference instead of claiming all work is clear.
- No browser-local desktop sort preference is copied across devices. Saved server order and the shared default selectors determine this view.
- Offline mode preserves only an already loaded, confirmed view. Offline cold launch is not supported. Failed writes never silently imply completion.
- No new auth flow, OAuth setting, credential, permission, or glasses-specific browser capability is introduced. The working email-code login is unchanged. The unpublished Google diagnostic commit `f209c94` is excluded.
- Base: `ecf0f67d7a944187dffa94e483df110fedd9714b`, the email-auth release baseline. No dependency on or modification to PR421/422. This feature requires the HTML and shared JavaScript assets to ship together; no migration is needed.

## Validation

Run `npm run lint` and `npm test` with supported Node 20. This static Express app has no separate frontend build command.

For synthetic browser QA, run `scripts/glasses-review-server.mjs` with `DCC_GLASSES_REVIEW=1` and either `DCC_PGLITE_MODULE` pointing to a PGlite installation or `DCC_TEST_DATABASE_URL` pointing to a disposable database. It uses the real account-binding and task-completion middleware. Then run `node scripts/verify-glasses.mjs http://127.0.0.1:<fixture-port>`. Do not point this at production or the user's live local database.

The walkthrough covers 600×600, 375×812, and 1440×1000 layouts; all pills and counts; completed/incomplete/nested/overdue/unscheduled work; source notices; empty accounts; scrolling and focus; reload/date modes; failed history expansion; offline/auth interruption; lost acknowledgements; repeated completion; account switching and isolation; and secondary routine recovery. A separate static desktop fixture smoke checks the shared queue modules in the actual desktop HTML.

These are simulated viewport/keyboard checks. This new layout has not been qualified on physical Meta glasses or with real touchpad/Neural Band input.
