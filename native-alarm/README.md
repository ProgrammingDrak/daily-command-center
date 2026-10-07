# DCC native Android alarm companion

This is a small standalone Android 12+ application alongside DCC, not a web-framework migration. It has no network permission, cloud account, production task access, WebView bridge, or paid service dependency.

The DCC browser's **Export definitions for Android** button downloads versioned JSON containing alarm definitions only. On the phone, **Import alarm JSON** uses the Android document picker, validates a bounded file, then asks the person to confirm replacement and scheduling. Imports preserve consumed occurrence IDs and refuse replacement while a quiz is pending. Definition enabling/disabling is available natively. The browser never claims this export arms a phone or tracks phone acknowledgement.

## Native behavior

- Device-protected SQLite definitions, occurrence ledger and challenge snapshots; transactionally saved quiz questions/progress survive process/reboot recovery. This permits scheduling after locked boot without DCC credentials or login. Alarm names/configuration are available before unlock; no sensitive account data belongs in this store. Backups are disabled.
- One `AlarmManager.setAlarmClock()` event per enabled definition, immutable explicit pending intents, identity/enabled/ledger checks at receipt, and duplicate refusal. Selected weekdays are scheduled as successive exact one-off events. Late events over 60 seconds are skipped.
- Receivers rebuild future events on locked/unlocked boot, clock/timezone change, app replacement and exact-access grant. They never start alarm audio from boot/recovery. Expired occurrences are marked missed, never played as a backlog. DST gap/fold and device-timezone behavior matches DCC's browser model.
- Foreground media-playback service uses alarm audio attributes, transient audio focus, the system alarm ringtone and imported capped volume. Wake lock is bounded, sound has a five-minute safety stop, and focus loss silences playback. There is no system-volume override or battery-whitelist request.
- A high-priority alarm notification may show the native quiz Activity on the lock screen only where allowed. Full-screen, exact-alarm, notification/channel and system-volume checks gate scheduling. Missing capability is explicitly **Not armed**, with no inexact fallback claim. System DND/OEM behavior still needs phone testing.
- Number quizzes/math, three difficulty levels, 1–10 questions, native keyboard submission, persistent progress, explicit silence/resume sound, notification emergency stop, and an emergency button that skips all pending quizzes. Only completion removes a quiz as completed. Different simultaneous alarms queue; only one sounds at a time.
- Native snooze is deliberately disabled in this first companion build. Browser snooze remains a prototype feature. Browser chime/pulse choices use the Android system alarm ringtone here; preview is an explicit four-second gesture.
- Permission/settings screens open only from the person's labeled button. No automatic grants, persisted document permissions, access to arbitrary DCC state, or hidden enrollment.

Force-stop/power-off prevent delivery; Android 15 cancels pending intents on force-stop. Reopening reconciles future definitions. Android private-space locking also stops the app. Process death/swipe-away differs from force-stop, but supported phones must be validated before calling this a dependable wake-up product.

## Build and tests

Requires JDK 17, Android SDK platform/build tools 35, and Gradle 8.11.1 (wrapper included). API 35 target, minimum API 31. AGP 8.9.2 pins a documented compatible toolchain. Set `ANDROID_HOME` or a local `local.properties` SDK path.

```sh
./gradlew testDebugUnitTest assembleDebug
```

Debug signing is disabled. The build produces **app-debug-unsigned.apk**, which cannot be installed until an explicit later signing/install decision. No signing key is generated or used. Neither production signing nor deployment is included.

Six Robolectric tests simulate SQLite reload, duplicate/early/stale/late delivery, saved correct-answer progress, malformed import rollback, pending import refusal, disable/emergency cancellation and exact-permission denial. They never start the audio service or schedule an alarm on a real device. A pure-Java `ClockRulesTest` main contains nine synthetic DST/weekday/timezone/late-delivery checks. Java/API compilation and unsigned APK build are verified separately.

No phone/emulator runtime, locked-screen screenshot, Doze test, service death/reboot integration test, OEM battery test, DND/audio-focus playback test or TalkBack session has been performed. The Robolectric checks validate local transitions; they do not prove Android OS/OEM wake-up reliability. Device installation and permissions need the user's action-time approval. No sleep tracking is included.

Official references: [alarm scheduling](https://developer.android.com/develop/background-work/services/alarms), [exact alarm access](https://developer.android.com/about/versions/14/changes/schedule-exact-alarms), [full-screen access](https://developer.android.com/about/versions/14/behavior-changes-14#secure-fsi), [foreground service types](https://developer.android.com/develop/background-work/services/fgs/service-types), [Doze](https://developer.android.com/training/monitoring-device-state/doze-standby), [force-stop](https://developer.android.com/about/versions/15/behavior-changes-all#stopped-state), [AGP toolchain](https://developer.android.com/build/releases/agp-8-9-0-release-notes).
