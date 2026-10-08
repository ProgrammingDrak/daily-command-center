# Android alarm integration readiness — 8 October 2026

Current main is integrated locally in the isolated feature branch under the renewed integration/ship authorization. No deployment, signing key, device install, permission grant or real alarm was performed. This is not an install-ready or validated mobile release.

## Reconciled source

Feature baseline: `cbcbba48b21873c9867d43e8fef1e1f0e90cd398` (`feat/challenge-alarm`, Android 0.5). Fetched main: `b126acc5cd290fcb73a73af8cb1c670724565a8a` (private collaborative daily commitments #402). Main has 21 commits since the feature base. A `git merge-tree --write-tree` dry run produced tree `b4120d73d33d2665a8990222dba7c18a9cb2ed4b`; it did not change either branch or working index.

The local merge resolved exactly two textual conflicts by retaining both additions:

- `index.html`, stylesheet insertion around lines 18–22: retain the alarm and Review Tomorrow stylesheets.
- `public/js/features.js`, immediately after `_addModalBlockId` assignment, around lines 421–434 in the virtual merge: retain the alarm link/status UI and main's `DCC.Activity.taskButton(...)` call. The latter targets its separate activity entry; removing it would regress workout/meal workflows.

`server.js`, `routes/blocks.js` and `public/js/schedule.js` merged automatically. Integrated validation preserves current task/date tabs, Review Tomorrow, activity workflows and private commitments. The new coexistence browser check caught a missing `am-activity-entry` host in main’s compact task markup; it is restored beside the task metadata so the retained activity hook can render its plan/log controls. A conflict-cleanup error was caught in browser QA and corrected before the passing checks; separator comments and executable declarations are preserved.

## Prepared compatibility fix

Main now pins same-origin API requests to the account/workspace served in app-config. The standalone Alarms page does not load the dashboard fetch wrapper. Its API reads now capture that original identity once and send `X-DCC-User` / `X-DCC-Workspace`; changing the global config cannot silently switch their identity. Legacy config without these fields remains supported until integration. A server account change is refused rather than treated as event cancellation, so the last confirmed local alarm remains armed.

The database-free browser fixture checks this with synthetic account headers, event data, clock, native bridge and audio. It also exercises saved-ID linkage, offline/unknown/deleted/rescheduled events, disabled proposals, challenge settings, input validation, keyboard/status accessibility and browser fallback. No native source changed, so the existing unsigned 0.5 APKs were not rebuilt.

Integrated checks passed: 179 focused Node tests; 20 commitment/activity PostgreSQL tests in a newly initialized disposable cluster on port 54219; 19 event browser assertions (including activity controls beside the alarm link); 32 independent alarm browser assertions; 6 task/date viewport and timezone cases; and 15 synthetic commitment UI/privacy scenarios. Syntax and whitespace checks passed. Browser source lint with declared browser globals has no errors and two existing unused-catch warnings. Native source is byte-for-byte identical to the staged source of the previously built unsigned 0.5 APK, so no native rebuild was performed. The 31 native tests from that build remain prior evidence, not newly rerun integrated tests. The live DCC database/server was never used for QA. Temporary fixtures were stopped after validation.

## Remaining decisions and release steps

1. **Code integration completed:** Drake’s renewed authorization superseded the earlier no-merge restriction. Current main `b126acc` is integrated locally. No production ship was attempted. The shared ship-it skill says to run the complete pipeline only when a real change is ready; this unsigned, physically unvalidated feature has not entered the integration FIFO or claimed a release lane.
2. **Private test device and signing:** identify phone model, Android version and country; choose a stable Drake-owned signing identity, key custody/backup and private transfer/install channel. Neither the standard nor isolated Android debug keystore exists. No key was generated/read. The current APKs are unsigned and cannot be installed. A paid service or Play Store release is not required. Signing and installation require their own action-time approval; do not send passwords or private keys in chat.
3. **Server release readiness:** native login requires this branch's routes/logout hook, `DCC_ANDROID_AUTH_ENABLED=true`, and `DCC_ANDROID_SIGNING_SHA256` set to the actual installed signer certificate fingerprint, not the APK file hash. The fixed host must serve a public nonredirecting Digital Asset Links JSON for `com.drake.dccalarm`. Confirm a single Node process/replica, or implement an approved shared atomically consumed short-lived grant store before enabling multiple replicas. Railway CLI is unavailable here, so deployed replica topology remains unverified. Standing authorization permits the ship-it pipeline once ready, but does not authorize new credential configuration or device grants. Signing configuration and device verification are still pending. The feature must pass the shared release queue, reviews and exact-candidate gates before production rollout; no incomplete rollout was attempted.

Read-only production observations on 8 October: health reports revision `b126acc...` and database OK; Clerk is configured; native auth config returns HTTP 401 and assetlinks did not yield usable JSON. Latest main lacks the prepared native routes. Google provider availability, existing-account identity mapping, browser handoff and automatic App Link verification still require real signed-device QA after release approval; no account records were queried.

## Exact limits

Web alarms are a visible/awake browser prototype, not dependable wake-up alarms. Native Android delivery still depends on OS permissions, notification channel/system volume, battery/OEM behavior and device state; force-stop, power-off and restricted/private-space states can prevent delivery. Physical locked/background/reboot/DST/time-zone and permission-denial QA remains pending; mocks and unit tests cannot establish device reliability.

Enabled event alarms retain the last confirmed time when refresh is stale/offline. The 24-hour threshold is a warning, not a delivery cutoff. Confirmed cancellation/deletion or explicit disable stops delivery; lost access does not. Offline provider changes can therefore leave an old alarm time armed. Google realtime calendar sync remains disabled. No sleep tracking/health analytics is included.

See [release/auth boundary](ANDROID-AUTH-RELEASE.md), [alarm architecture and platform limits](CHALLENGE-ALARMS.md), and [event policies](EVENT-LINKED-ALARMS.md).
