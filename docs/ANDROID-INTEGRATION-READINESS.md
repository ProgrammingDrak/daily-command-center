# Android alarm integration readiness — 8 October 2026

Local preparation only. No merge, deployment, signing key, device install, permission grant or real alarm was performed.

## Reconciled source

Feature baseline: `cbcbba48b21873c9867d43e8fef1e1f0e90cd398` (`feat/challenge-alarm`, Android 0.5). Fetched main: `b126acc5cd290fcb73a73af8cb1c670724565a8a` (private collaborative daily commitments #402). Main has 21 commits since the feature base. A `git merge-tree --write-tree` dry run produced tree `b4120d73d33d2665a8990222dba7c18a9cb2ed4b`; it did not change either branch or working index.

Exactly two textual conflicts require retaining both additions:

- `index.html`, stylesheet insertion around lines 18–22: retain the alarm and Review Tomorrow stylesheets.
- `public/js/features.js`, immediately after `_addModalBlockId` assignment, around lines 421–434 in the virtual merge: retain the alarm link/status UI and main's `DCC.Activity.taskButton(...)` call. The latter targets its separate activity entry; removing it would regress workout/meal workflows.

`server.js`, `routes/blocks.js` and `public/js/schedule.js` merged automatically in the dry run. This is not integrated validation. Preserve current task/date tabs, Review Tomorrow, activity workflows and private commitments during eventual review.

## Prepared compatibility fix

Main now pins same-origin API requests to the account/workspace served in app-config. The standalone Alarms page does not load the dashboard fetch wrapper. Its API reads now capture that original identity once and send `X-DCC-User` / `X-DCC-Workspace`; changing the global config cannot silently switch their identity. Legacy config without these fields remains supported until integration. A server account change is refused rather than treated as event cancellation, so the last confirmed local alarm remains armed.

The database-free browser fixture checks this with synthetic account headers, event data, clock, native bridge and audio. It also exercises saved-ID linkage, offline/unknown/deleted/rescheduled events, disabled proposals, challenge settings, input validation, keyboard/status accessibility and browser fallback. No native source changed, so the existing unsigned 0.5 APKs were not rebuilt.

After integration approval, resolve these two conflicts and run focused alarm/auth tests, task/date/activity and commitment account/privacy checks, and the loopback browser fixture against the integrated source. Do not run the normal database-connected server or indiscriminate database tests. Rebuild an APK only if native/package inputs change.

## Remaining decisions and release steps

1. **Integration approval:** an earlier actual merge was denied by automatic approval review because the task explicitly prohibited merges. No combined checkout or substitute integration was made. Approval to integrate current main is required before doing so.
2. **Private test device and signing:** identify phone model, Android version and country; choose a stable Drake-owned signing identity, key custody/backup and private transfer/install channel. Neither the standard nor isolated Android debug keystore exists. No key was generated/read. The current APKs are unsigned and cannot be installed. A paid service or Play Store release is not required. Signing and installation require their own action-time approval; do not send passwords or private keys in chat.
3. **Separate server release:** native login requires this branch's routes/logout hook, `DCC_ANDROID_AUTH_ENABLED=true`, and `DCC_ANDROID_SIGNING_SHA256` set to the actual installed signer certificate fingerprint, not the APK file hash. The fixed host must serve a public nonredirecting Digital Asset Links JSON for `com.drake.dccalarm`. Confirm a single Node process/replica, or implement an approved shared atomically consumed short-lived grant store before enabling multiple replicas. Railway CLI is unavailable here, so deployed replica topology remains unverified. This requires separate ship approval; integration approval does not authorize deployment.

Read-only production observations on 8 October: health reports revision `b126acc...` and database OK; Clerk is configured; native auth config returns HTTP 401 and assetlinks did not yield usable JSON. Latest main lacks the prepared native routes. Google provider availability, existing-account identity mapping, browser handoff and automatic App Link verification still require real signed-device QA after release approval; no account records were queried.

## Exact limits

Web alarms are a visible/awake browser prototype, not dependable wake-up alarms. Native Android delivery still depends on OS permissions, notification channel/system volume, battery/OEM behavior and device state; force-stop, power-off and restricted/private-space states can prevent delivery. Physical locked/background/reboot/DST/time-zone and permission-denial QA remains pending; mocks and unit tests cannot establish device reliability.

Enabled event alarms retain the last confirmed time when refresh is stale/offline. The 24-hour threshold is a warning, not a delivery cutoff. Confirmed cancellation/deletion or explicit disable stops delivery; lost access does not. Offline provider changes can therefore leave an old alarm time armed. Google realtime calendar sync remains disabled. No sleep tracking/health analytics is included.

See [release/auth boundary](ANDROID-AUTH-RELEASE.md), [alarm architecture and platform limits](CHALLENGE-ALARMS.md), and [event policies](EVENT-LINKED-ALARMS.md).
