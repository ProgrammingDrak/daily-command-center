# Daily Command Center Android app — challenge alarms, phase one

One Android application contains DCC's existing remotely loaded dashboard and a native, offline alarm scheduler/challenge screen. `native-alarm/` is the project directory, not a separate companion product. Version 0.2, package `com.drake.dccalarm`, Android 12+ (API 31), compile/target API 35. No paid service or new credentials.

## Shared UI, native authority

`MainActivity` loads only `https://daily-command-center-production-1d04.up.railway.app`. Dashboard/backend behavior and tasks remain the existing DCC implementation. The native toolbar always offers **Device alarms**, including when the dashboard cannot load. Phone alarms can be created, edited, enabled/disabled and removed in the native screen, without network, login, browser definitions or deployment of this branch's web feature.

Alarms belong to **this phone**, shared across DCC accounts on it. Logout/account switching does not clear alarms or saved quiz progress. The browser/PWA and this WebView have separate cookies and IndexedDB. No silent migration, browser-to-phone sync, credential transfer, or second device acknowledgement is claimed. Removing an old PWA shortcut is a later user choice. If a prior APK of this package exists, upgrading retains its native alarm database; cross-package migration is not implemented.

The branch web feature detects the native bridge or shell user-agent marker, disables its browser scheduler, and offers native management. If the bridge is unavailable, the toolbar remains usable; the browser scheduler stays disabled. An explicit transfer can review this WebView's existing alarm definitions, or import a versioned JSON file with Android's document picker. Both require native **Save and schedule** confirmation, replace phone definitions transactionally, preserve consumed occurrence history, refuse replacement while a quiz is pending, and never grant permissions. The current production dashboard does not yet have the branch feature; the native toolbar/editor work without it.

## Bridge and navigation boundary

- AndroidX WebKit `addWebMessageListener` uses one exact HTTPS origin, never `*`, plus callback-origin, main-frame and current-page checks. No `addJavascriptInterface`, arbitrary native object, eval operation, account token, server secret, cookie or task access is exposed.
- Only `status`, `open` and `review` actions exist. Review messages are bounded to 64 KiB/20 definitions and use the same native validation/confirmation as file import. Binary/unknown/malformed messages cannot arm alarms. Status reports only phone alarm capability text.
- Main-frame navigation stays on the fixed DCC origin. Cross-origin HTTPS links require a visible external-browser decision. Credential URLs, cleartext, `file:`, `content:`, `javascript:` and `intent:` navigation are rejected. Caller-controlled Intent URLs are ignored. No untrusted popup inherits a bridge.
- TLS errors fail closed; mixed content, file/content browsing and third-party cookies are disabled. Media playback requires a gesture. Web camera/microphone/geolocation requests are denied. DCC file inputs use an explicit system document picker with transient user-selected `content:` URIs, not persisted access or camera permissions.
- Login reuses the existing DCC page and `drake-auth` session. Username/email login is the available in-shell path. Google OAuth/new-window/provider behavior needs real-device validation; external browser cookies are not imported and an OAuth return handoff is **not implemented**. Popups show honest guidance to use DCC's username/email login. Native alarms work while logged out. File downloads/external-browser sessions and all existing task workflows need device QA; this is not yet a validated replacement for the installed PWA.

[Android bridge security](https://developer.android.com/privacy-and-security/risks/insecure-webview-native-bridges), [WebViewCompat origin-scoped listener](https://developer.android.com/reference/androidx/webkit/WebViewCompat#addWebMessageListener(android.webkit.WebView,java.lang.String,java.util.Set,androidx.webkit.WebViewCompat.WebMessageListener)).

## Native alarm behavior and limits

- Device-protected SQLite definitions, occurrence ledger and challenge snapshots permit locked-boot scheduling without DCC credentials. Questions/progress survive process death/reload transactionally. Alarm labels/configuration are accessible before first unlock; do not place account secrets in them. Cloud/device-transfer backup is disabled.
- One `AlarmManager.setAlarmClock()` event per enabled definition; immutable explicit pending intents; enabled/identity/ledger checks and duplicate refusal. Repeat weekdays use successive exact one-offs. Definitions follow the device timezone. Spring gaps move forward, fall folds choose the earlier offset and consume one local date.
- Boot, time/timezone changes, app replacement and exact-access grant reconcile future occurrences. Overdue recovery events are skipped; boot never plays a backlog. Normal receipt permits at most 60 seconds lateness. Force-stop/power-off cannot ring; Android 15 force-stop cancels pending intents. Private Space locking also stops the app. Reopening restores future schedules, not missed wake-ups.
- Exact, notification/global/channel, full-screen and system alarm-volume checks gate scheduling. Missing access means **Not armed**, with no disguised inexact fallback. Permissions/settings open only after labeled native button presses; no automatic enrollment or battery-whitelist request. Denial/revocation is checked on resume and delivery.
- Native foreground media-playback service uses alarm audio attributes, transient audio focus, the system alarm ringtone and capped configured volume. It does not override device alarm volume or DND. Wake lock and sound are bounded; five-minute safety stop consumes pending challenges. Focus loss/audio failure silences sound.
- Math/number quizzes, easy/medium/hard, 1–10 answers, keyboard/IME submission, persisted progress, queued simultaneous alarms, explicit silence/resume, and emergency stop in both screen and notification. Stopping sound alone does not claim quiz completion. Native snooze is disabled in phase one. Chime/pulse browser tones map to the system ringtone. Four-second preview requires a gesture.

These are implemented platform mechanisms, **not a universal wake-up guarantee**. OEM battery policies, Doze, reboot, lock-screen presentation, DND/audio focus, notification availability and process/service death must be validated on the actual phone before relying on it.

## Maintenance boundary

| Change | Delivery and maintenance |
|---|---|
| Dashboard/task UI and backend | Existing web deployment; the shell remotely loads the same UI. No second task implementation. Changing the trusted deployment host or native bridge contract can require an APK update. |
| Alarm scheduler, native editor/quiz, bridge, Android permissions | New APK; native Java code, AndroidX/SDK dependencies and OS behavior need upkeep. |
| Alarm models | Browser prototype and native engine both exist. Scheduling/validation changes need contract checks in both until the prototype is retired or shared further. |
| Login and external navigation | Existing account backend; WebView/provider compatibility and any future OAuth handoff need maintenance and phone QA. |
| Distribution | Signing key ownership, updates and install channel are unresolved. No keys generated or used here. |
| Reliability | Real-device regression checks after native/OS/SDK changes; OEM battery behavior cannot be proved by web tests. |

This avoids maintaining two complete task apps but still adds a substantive native alarm subsystem. There is no account alarm-sync backend in this phase.

## Build and local evidence

JDK 17, Android SDK platform/build tools 35, Gradle 8.11.1 wrapper, AGP 8.9.2, AndroidX WebKit 1.12.1. Set `ANDROID_HOME` or a local SDK path.

```sh
./gradlew testDebugUnitTest assembleDebug lintDebug
```

Debug signing is disabled. `app-debug-unsigned.apk` cannot be installed until a later explicit signing/install decision. No device/emulator install, production signing/deploy or real audio has occurred.

Local validation: 14 JUnit/Robolectric tests cover native SQLite reload/queue/progress/duplicate/late delivery, rollback, pending import refusal, exact denial, exact-origin/frame/navigation policy, fixed dashboard origin, permission non-enrollment, native editor cancellation/review-before-save/offline independence, revoked-permission boot/time recovery and logout-cookie isolation. Nine pure Java synthetic clock checks cover DST/weekdays/timezone/late delivery. Browser QA uses a database-free loopback fixture, mocked clocks/audio, and an explicit native bridge mock. Screenshots of that mock are **browser previews, not screenshots of Android running**. No actual phone screenshot or TalkBack session is available yet. Android lint completes with zero errors and 37 warnings; localization and the deprecated Back API remain warnings.

## Required physical-device QA before reliance

Use a temporary test alarm while awake, with explicit signing/install and action-time permission approval. Keep a known working system alarm as backup during evaluation.

1. Launch dashboard, sign in via the existing credentials, navigate task/detail/overlay/back, upload a selected image, reload, logout, switch accounts; ensure no native credentials exposed and no task regressions. Test Google/provider navigation separately, expecting the documented handoff limitation. Test external hostile URL, subframe and popup behavior.
2. Create disabled one-off/repeat alarms, edit/count/difficulty/date/time/days, confirm/cancel replacements, enable, inspect obvious next occurrence, preview/stop sample, complete and emergency-stop quizzes using keyboard and TalkBack. Wrong/invalid answers must retain progress. Test two simultaneous alarms and reopen saved progress.
3. Deny then approve/revoke exact/notification/full-screen access and channel importance. Confirm **Not armed** and no phantom armed state, no silent access requests. Test zero system alarm volume, DND, no ringtone, interrupted audio focus, explicit silence, emergency notification stop and five-minute limit.
4. Locked/offline/background/closed dashboard; swipe away, kill process/service, force-stop separately; Doze/battery saver/OEM restrictions. Test reboot before first unlock and after unlock. The native alarm must not require WebView or login.
5. Time forward/back, timezone travel, spring/fall DST, reboot with overdue occurrences, repeat-day rescheduling, duplicate/stale delivery. No backlog sound or double occurrence. Confirm emergency/completion consumption and retained progress across reload.
6. Uninstall/clear data removes local alarms; backup is disabled. Upgrade same signed package preserves definitions/ledger. Native alarms continue after dashboard logout by design; explicitly disable/remove them when sharing the phone.

Record Android version, phone/OEM, permission/channel/battery/DND settings, timestamps and observed results. Only then choose a supported device claim. No sleep tracking or health analytics is included.

Official platform references: [alarms](https://developer.android.com/develop/background-work/services/alarms), [exact access](https://developer.android.com/about/versions/14/changes/schedule-exact-alarms), [full-screen access](https://developer.android.com/about/versions/14/behavior-changes-14#secure-fsi), [foreground services](https://developer.android.com/develop/background-work/services/fgs/service-types), [Doze](https://developer.android.com/training/monitoring-device-state/doze-standby), [force-stop](https://developer.android.com/about/versions/15/behavior-changes-all#stopped-state).
