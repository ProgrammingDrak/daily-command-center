# DCC MCP capability audit

## Root causes before implementation

- The remote OAuth server lives in `routes/conversation.js` at `/mcp/dcc`. The stdio `mcp/dcc-mcp` operator scheduler is a separate existing client surface and does not register ChatGPT tools.
- Live Railway revision `e333df8` advertises the task, repeat, queue, time, organization and file scopes shipped in #498. `tools/list` filters by the current grant. Legacy `dcc.read` and `dcc.reconcile` grants cannot discover `dcc_tasks` or `dcc_files`. The reported tool list is consistent with a legacy grant or cached discovery. Diagnosing the actual account requires `dcc_connection_status` in that connection.
- ChatGPT maintains its own action catalog. Refresh and enable new actions after obtaining the relevant OAuth scopes. DCC deployment alone cannot update a ChatGPT workspace catalog.
- `dcc_tasks` already creates and moves canonical task rows. Its schedule contract only accepts a civil date and start against the app's scheduling zone. `dcc_calendar_events` only reads meeting data. There is no remote date-range itinerary reader, zoned write, or canonical structured itinerary location input.
- #479 added Calendar viewing zones and optional instant metadata on blocks. It did not add per-entry zoned scheduling throughout DCC. Existing task attachments already accept bytes with account scoping. An attachment in a chat does not by itself grant DCC access to the bytes.
- Draft #506 changes the OAuth provider boundary and legacy service authorization. It is independent of exposing itinerary operations through present account OAuth.

## Capability inventory

The test column describes the current branch's coverage. Public production ingress
was checked before implementation. Authenticated production verification requires
an explicitly approved account and remains open.

| DCC surface | Existing UI and backend | MCP permissions and operations | Test or limitation |
| --- | --- | --- | --- |
| Task Library, Someday and tasks | Yes, project store and blocks | `dcc.tasks.read/write`, `dcc.capture`. List, get, create, edit, schedule, complete, reopen, restore and read mutation history | OAuth and PostgreSQL. No canonical general-purpose due date separate from scheduled date |
| Task hierarchy | Yes, block graph | `dcc.tasks.write` creates under a parent and uses the canonical hierarchy guard | PostgreSQL. Existing-parent reparenting and nested zoned moves still use DCC UI |
| Projects, categories, views and import | Yes, project store | `dcc.organization.read/write`, plus task write for import | Existing contract. Project reordering and all UI import options are unverified through MCP |
| Waiting and dependencies | Yes, Waiting routes and transactional graph | Queue blockers/delegation through `dcc.queue.write` or `dcc.delegate` | Native Waiting dependency creation/removal and check-in graph are unavailable through MCP |
| Repeats and occurrence lifecycle | Yes, responsibility store and recurrence materializer | `dcc.repeats.read/write`, task write for cleanup | PostgreSQL cleanup fixtures. No full series-edit and occurrence-management parity |
| Itinerary plan and native calendar scheduling | Yes, canonical dated task blocks and mover | `dcc_itinerary` with `dcc.itinerary.read`. `dcc_itinerary_write` also requires `dcc.itinerary.write` | OAuth/PostgreSQL Tokyo fixture. Plan dates group native activities. No separate itinerary record |
| Itinerary fixed commitments and reordering | Yes, timed placement and day ordering | Versioned explicit reschedule and exact overlap allowlist. An explicitly scheduled start requires move confirmation in the tool call | Overlap, fixed-move and stale edits tested. Free-form reorder, all-day writes, and moves across a storage-zone midnight remain gaps |
| Itinerary locations and travel | Yes, Task Details location and directions | `dcc.itinerary.write` saves structured place details and travel fields on the same block | Coordinates, links and service data persist. Commute estimation and routing remain in DCC |
| Google Calendar | Yes, Google sync and materialized appointments | `dcc.calendar.read` or legacy `dcc.read`. Provider-owned events are read-only through itinerary operations | Discovery tested. Date reads reflect materialized DCC data. Provider event changes belong in Google Calendar |
| Timezone preferences | Yes, Calendar Follow Device and manual preview from #479 | Itinerary read takes a viewing zone. Writes preserve UTC instants and origin timezone | DST gaps and folds tested. Itinerary list, Today, actuals and physical glasses lack full viewing-zone parity |
| Private files and attachments | Yes, task attachment routes and private storage | `dcc.files.read/write` for list, download, upload, remove and restore. `dcc_attach_chat_file` accepts ChatGPT-authorized file params | Synthetic bytes and isolation tested. Replacement is upload then remove. Real ChatGPT file URLs and production object storage require live verification |
| Working Queue and timers | Yes, account coordinator | `dcc.queue.read/write` or legacy `dcc.read/work`. Membership, order, priority, foreground and background, pause, snooze and blockers | Existing coordinator suites. Queue full control includes timers and delegation |
| Delegated/background work | Yes, queue and sitrep surfaces | `dcc_delegate` uses queue write or legacy `dcc.delegate` | Existing coordinator suites. Worker execution must be reported by the host. No arbitrary worker launch or stop |
| Completion, reconciliation and follow-up | Yes, canonical completion and reconciliation | Task write for explicit completion and reopen. Legacy `dcc.reconcile` for reviewed outcomes and next iterations | Nov 16 completion runs only after an explicit fixture instruction. Elapsed plans remain open |
| Work history and time correction | Yes, work sessions, actuals and time allocation | `dcc.time.read/write`, legacy `dcc.read/correct`. Per-task block history with `dcc.tasks.read` | Existing suites. Whole-day actual adjustment surface has additional UI operations |
| Recoverable deletion | Yes, tombstone and recovery | `dcc_bulk_cleanup` with task read/write and independent `dcc.cleanup.read/write`, plus repeat scopes for series | Existing PostgreSQL tests. Connected calendar events and completed history are protected |
| Wishlists | Yes, private Wishlist store | Legacy `dcc.wishlist.read/write` | Existing Wishlist tests |
| Workout records, exercise library, routines and guided outcomes | Yes, Activity and Guided services | Basic task and recurrence operations where applicable | Native log editing, library catalogs and guided session outcomes need separate contracts |
| Meeting preparation and review | Yes, Meeting routes and materializer | Snapshot of calendar commitments and separately scheduled task actions | Meeting artifacts, recordings, attendee actions and publishing have no equivalent general MCP grant |
| Calendar settings and social sharing | Yes, Connections and sharing services | DCC browser handles OAuth and sharing | Provider tokens, shares, member roles, invite links and sharing mutations are outside these grants |
| Journal, vault, ink and reference management | Yes, Vault and sync services | No tools on the remote DCC ChatGPT endpoint | Private content needs its own account model and scoped surface |
| Budget, reimbursement, time and costs | Yes, domain-specific stores and itinerary ledger | Time records as listed above | Expense writes, ledger amounts and reimbursements are outside the existing grants |
| Access administration, evaluation, rewards, pet, slots and sponsorship | Yes, dedicated APIs with separate guardrails | No tools on the DCC ChatGPT endpoint | Each needs its own authorization and consequence model before exposure |

A placement checks persisted workspace rows, including all-day provider holds.
The concurrency tests cover new inserts and promotion of existing dateless rows.
A later manual edit or provider update can introduce an overlap after the write.
Read the itinerary after calendar sync to reconcile new conflicts.

## Reconnect and refresh

1. In DCC, open **Settings → Connections → ChatGPT** and choose **Tasks and
   scheduling**, **Itinerary**, and **Task files** with Full control. Choose
   Connected calendar Read only and other categories as needed.
2. Use the OAuth scopes under **Manual connection details** in the existing
   custom MCP connection. Authorize the intended DCC account and workspace.
   Reductions and disconnect apply to existing grants. Additional scopes
   require a fresh OAuth authorization.
3. In ChatGPT workspace app settings, refresh or scan the DCC app's actions
   after authorizing those scopes. For managed apps, review and enable new
   actions. In a new chat select DCC and call `dcc_connection_status`.
4. For ChatGPT-hosted screenshots, select the original file when prompted by
   `dcc_attach_chat_file`. URLs must be provided by ChatGPT file parameters.
   The approved download host is `files.oaiusercontent.com`. If the host does
   not provide file parameters or uses a different origin, save the original
   locally and upload it in the canonical activity's **Task Details → Notes**.
   An authorized MCP host with file bytes can also use `dcc_files` upload.
   Do not ask a model to reconstruct image bytes from appearance.

[OpenAI custom MCP setup and action refresh](https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt)
[OpenAI plugin file-parameter contract](https://developers.openai.com/plugins/reference)

## Fixture check

The November 16 scenario uses a disposable PostgreSQL schema, synthetic
sightseeing slots and a synthetic ticket PNG. Dinner and train times match the
acceptance request. The in-train CapCut activity requires an explicit overlap
with the train. No real ticket, receipt, reservation, or production itinerary is
used by the test.
