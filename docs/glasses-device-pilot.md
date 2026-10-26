# Glasses presentation pilot (local, not released)

This pilot adapts the canonical full DCC app, following the user's physical-glasses feedback. It does not extend the old `/glasses.html` summary. Base: deployed PR428, `4f27b48e1f0daa5ddca94af79d4fcd5a8fe56a14`. Branch: `prototype/glasses-device-view`. PR421/422 and their migration release remain untouched.

## Try the actual prototype

Use Node 20/22. Do not run `npm start`, use a production database, or point this harness at the normal live localhost:8090.

```sh
PORT=8399 DCC_REVIEW_GLASSES_DEVICE=1 node scripts/ui-review-server.mjs
# Open http://127.0.0.1:8399/?device=glasses
# Canonical comparison: http://127.0.0.1:8399/
node scripts/verify-glasses-device-view.mjs
```

The server is bound to loopback and seeded with disposable tasks. The test runner verifies `reviewOnly`, resets only this opt-in fixture set, blocks external requests, and restores the fixtures afterward. The UI's Full app link removes only the presentation flag; other query parameters and fragments survive.

## Interaction to review

- **Up/down while a task title is focused:** previous/next visible canonical row in the active list or queue. Handled events prevent native traversal from also running. At a boundary the event remains available to the browser.
- **Left/right and arrows on other controls:** browser-managed spatial navigation. The pilot does not install a page-wide manual focus index. Tab retains normal traversal.
- **Enter on a title:** existing task details. **Done:** confirmation, with Keep as is focused first. Confirmation forwards one click to the existing shared action. Repeated confirmation cannot submit twice.
- **Completed task → Reopen:** confirmation then the existing reopen action. Parent/subtask completion and point rules are unchanged.
- **More:** reveals existing row controls. **App tools:** reveals the full app's navigation/utilities. All five original queue pills and their counts remain at the top.
- **Next/Previous buttons:** provide an explicit alternative to directional task movement. Focus returns to the selected task, which scrolls into view.
- **Escape in confirmation:** cancels without submitting. Queue confirmations contain their own Tab/pointer events, so the drawer behind them cannot steal focus or close prematurely.

Meta's current public documentation says the page receives ArrowUp/Down/Left/Right and Enter; the WebView spatially moves focus and activates controls. The display target is 600×600 additive light. The native shell's Back uses browser history. This pilot uses standard DOM, CSS and `<dialog>`, with no sensor permission, credential, SDK or grant additions. Physical gesture-to-key mapping is owned by Meta's runtime; this is not a custom swipe recognizer. Documentation read through Meta's official public Wearables Documentation MCP on 2026-10-25: https://mcp.developer.meta.com/wearables . Entry points: https://developers.meta.com/wearables/web-apps/ and https://wearables.developer.meta.com/docs/develop/webapps/wearables-documentation-mcp .

## Shared-domain boundary and parity

`public/js/device-views/glasses.js` is a presentation adapter. It decorates the existing `.it-list-item` DOM and delegates actions to the controls already rendered by `createTaskListRowRenderer` / `renderItineraryListRow`. It does not fetch, filter, reorder, clone task records or implement completion persistence. The original TaskModel, TimeBlocks, queue selectors, account wrapper and permissions remain authoritative. No other device stubs are introduced.

The regression compares exact eligible, timed, unscheduled and folded task ID arrays; rendered order, completion state and indentation; and all five pill counts between canonical and adapted modes for the same fixture account/date/filter. It includes done/incomplete/untimed/nested tasks and an overdue fixture. Queue filtering continues through the original pill handlers, not a presentation-specific predicate. Canonical collapsed children remain collapsed until expanded; visible task navigation counts are explicitly labelled “visible.”

## Validation and remaining work

- Repository suite: 3,132 pass, 11 skip; no new backend/schema changes.
- Browser regression: parity; bounded arrows and default suppression; canonical details/actions; cancel; offline no-submit; stale account/date/state/removal rejection; one shared completion; reopen; permission-error rollback; focus restoration; queue isolation and confirmation; empty state; 600×600, 375×812 and 1440×1000.
- Five independent pre-review lanes completed. Two confirmed queue-navigation/dialog issues were repaired and regression-tested; correctness/test reviewers rechecked the fixes.
- No production task mutations, push, PR, merge or deployment for this redesign.

This is a reviewable local prototype, not on-device qualification. Ordinary desktop Chromium does not reproduce Meta's native spatial navigation. The Meta simulator and physical touchpad/Neural Band must verify left/right target choice, edge focus, scrolling, text composition, one activation per pinch, and Back behavior through existing app dialogs. Existing full-app dialogs do not uniformly map to browser history; hardware Back is not claimed to work as Escape. No real-device auth test was performed by this task. Email-code authentication and the deployed Google diagnostics are unchanged.

Offline attempts made while the browser reports offline are blocked by the adapter. A connection loss after submission still uses DCC's existing pending/retry/rollback semantics and status toasts; a checked row is not proof of server acknowledgement. Authentication interruption and account switching remain the full app's responsibility. The pilot does not add offline cold-launch caching or persist a separate selected-task model. Selection restores across DOM rerenders; reload uses canonical app state and selects the first visible task.

## Release preparation, October 26

The user authorized shipping after reviewing the prototype. PR430 refreshes its release checks while PR429's guided-task release is coordinated separately. No merge/deploy may occur before the parent hands over that release lane and the combined candidate is checked.

The refreshed browser suite has 19 check groups. It also covers Loose Ends focus containment, native text-field arrows, repeated Enter, and ordinary browser Back (page-history navigation, not modal dismissal). Confirmation text no longer promises reopening for source items that only support canonical dismissal. Fresh unauthenticated production browsing preserves `/?device=glasses` through the login redirect, and the existing Google/email provider UI loads at 600×600. No credentials were submitted; completed authentication and the physical Meta composer remain unverified.

Activation stays explicit at `/?device=glasses`, with a Full app exit. Normal launches are unchanged. PR429 overlaps the HTML shell and shared task presentation; retain its guided-conversation link and run combined rendering/action QA after reconciliation. There are no schema changes in this feature.
