# Android browser sign-in — review and release boundary

**Source is prepared and locally tested. The APK is unsigned; Google sign-in is not enabled or validated on a phone. This is not an install-ready release.**

## Verified existing account behavior

`server.js` requires an existing password hash for `/api/auth/login`. `auth.js` creates external/Google users without a password hash. A visible username/email form therefore does not establish that Drake has a usable password. No account records or passwords were queried or changed.

Production's read-only `/api/auth/config` confirms Clerk is configured. An anonymous request for Clerk's provider metadata returned 401, so the actual Google-provider flag has **not** been independently verified. The login page explicitly offers Google, with provider availability controlled by the existing Clerk application. Real browser/device QA must confirm the configured provider works for Drake. We do not require him to register another account or add a password.

## Prepared flow

1. The person's native **Google sign-in (browser)** button requires Android's automatic verified-domain state, then checks the release's server capability. No link verification grant or permission request is made automatically.
2. AndroidX Browser **Auth Tab** opens DCC's own `/auth/android/authorize` with a random state and S256 challenge. Unsupported browsers can fall back to Custom Tabs, with the same exact verified HTTPS App Link callback. The native PKCE verifier is private, ephemeral and never put in a URL, cookie, bridge, log or JavaScript.
3. An unauthenticated browser is sent to the existing `/login?next=...`. Clerk/Google authenticate using the existing web configuration and existing `/api/auth/clerk-sync`. No native Google client, scopes, keys, provider redirects or separate account mapper are added.
4. The existing authenticated DCC browser session displays the chosen account and explicit confirmation. A same-origin form nonce is bound to that session, account and workspace. Account changes, stale nonce, missing/cross-site Origin and malformed requests are refused. Cancel/change the browser account through the existing DCC browser UI, then restart the app attempt.
5. Confirmation issues a one-use, two-minute code to `https://daily-command-center-production-1d04.up.railway.app/auth/android/callback`. The app accepts only that HTTPS origin/path, an automatically verified domain, matching state, bounded elapsed time, and exactly one code/state pair. No custom scheme, caller URL, bearer token or cookie is accepted from an Intent.
6. Native HTTPS exchanges the code, state and verifier with `/api/auth/android/exchange`. The server checks PKCE and burns the code atomically before asynchronous work. It regenerates/saves DCC's existing session and returns its existing HttpOnly/Secure host-only root cookie. Native code validates cookie attributes and gives it directly to WebView's CookieManager, without exposing it to JavaScript.
7. Dashboard logout cancels any pending native attempt before changing the browser session. Cancellation/process death/stale callbacks fail closed. A canceled asynchronous cookie installation removes only that same candidate cookie, preserving a newer session. No provider/browser cookies are copied wholesale. Device alarms and saved quizzes remain independent of login/logout.

Flows live in bounded **single-process memory** (1,000 consent entries and 1,000 grants; five-minute consent/client deadline; two-minute grants). Restart cancels pending handoffs safely. Multiple Node processes/replicas need a shared short-lived, atomically consumed store before enabling this feature; no new database table/migration or paid service is included. Normal real sign-ins will use DCC's existing session store/login auditing only after the future release/user action.

## Exact decision required before enabling

Approve a stable signing identity and APK distribution/install channel for `com.drake.dccalarm`, plus the DCC server release. No key has been created, reused or read. The required public certificate value is the SHA-256 fingerprint of the **actual installed APK signer** (not a placeholder or an unsigned APK hash).

After approval, the release needs:

- `DCC_ANDROID_AUTH_ENABLED=true`
- `DCC_ANDROID_SIGNING_SHA256=<approved certificate SHA-256 in AA:BB:… form>`
- Deployment of this branch's server routes and logout hook on the existing fixed HTTPS DCC host.
- Public, nonredirecting `/.well-known/assetlinks.json` naming `com.drake.dccalarm` and that certificate; the prepared route serves it only when both settings are valid. The current default is disabled with no association.
- Confirmation of one Node process/replica, or an approved shared grant store implementation before enabling multi-replica operation. Read-only Railway inspection on 2026-10-08 22:06 UTC verified one active successful deployment, one effective `us-west2` replica and the single-Node `start:render` command. Recheck before enablement; restarts/rolling deploys invalidate pending process-local handoffs safely and require restarting sign-in. No settings were changed.
- Android automatic App Link verification and Auth Tab HTTPS verification on the signed test device. User-selected URL handling alone is refused. No new Google/Clerk provider credentials or provider redirect changes are required by this design.

Do not enable the feature merely because the local unit tests pass. Current production has no deployed native-handoff routes, approved signing identity or verified app association from this task.

## Required auth device QA

Use Drake's existing Google account with his action-time approval, and retain the installed PWA until validated. Check initial Google sign-in, correct existing DCC identity/tasks/workspace, explicit consent cancel, browser-account mismatch/switch, logout during config/exchange/cookie install, stale/double/spoofed callbacks, process death/restart, offline/network failure, Auth Tab verification failure/timeout, Custom Tabs fallback, device browser/back navigation and ordinary task workflows. Check native alarms/quizzes continue unchanged throughout. Google-provider availability is part of this check. No such real sign-in or device QA has occurred.

## Source and evidence

`lib/android-auth.js` is a session handoff after existing DCC authentication, not a replacement OAuth provider. Six synthetic server tests cover disabled config, login continuation, consent/CSRF/account isolation, escaped text, bounded requests, PKCE, session regeneration, expiry, replay and concurrency. Native tests cover callbacks/cookies/verification refusal and lifecycle; browser mock QA covers logout cancellation. These do not prove real Google/DAL/browser interoperability.

Official guidance: [OAuth for native apps: external user agents and claimed HTTPS redirects](https://datatracker.ietf.org/doc/html/rfc8252), [S256 PKCE](https://datatracker.ietf.org/doc/html/rfc7636), [Auth Tab HTTPS verification and fallback](https://developer.chrome.com/docs/android/custom-tabs/guide-auth-tab), [Android certificate/domain association](https://developer.android.com/training/app-links/configure-assetlinks), [App Link verification](https://developer.android.com/training/app-links/verify-applinks).
