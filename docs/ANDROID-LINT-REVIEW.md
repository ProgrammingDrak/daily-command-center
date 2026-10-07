# Android lint review — source versus execution evidence

The earlier unified 0.2 source at commit `7f00293` generated **0 errors / 37 warnings**. Preserve `alarm-evidence/native-lint-0.2.txt` as that historical report; do not describe it as the current build. The new report is `native-lint-0.3.txt`, generated from the 0.3 source matched by `source-build-match.json`.

| Original warning | Count | Review and correction |
|---|---:|---|
| `SetTextI18n` | 33 | Extracted reported UI strings and formatted feedback into Android string resources. These were localization findings, not proof of a broken screen reader. Other custom UI text remains English; no claim of full translation support. |
| `IconLauncherShape` | 1 | Existing DCC artwork now uses an adaptive launcher icon with a safe inset and monochrome layer. |
| `IconLocation` | 1 | Moved the bitmap into `drawable-nodpi`. |
| `GradleDependency` | 1 | Updated WebKit to stable 1.17.1. Auth uses Browser 1.10.0 and Activity 1.13.0; API 36 build headers/AGP 8.10.1 are required. Minimum API 31 and target API 35 remain deliberate. |
| `SetJavaScriptEnabled` | 1 | Security review retained explicitly. DCC requires JavaScript. Exact HTTPS origin/frame/current-URL checks, a narrow message listener, no `addJavascriptInterface`, no credentials in the bridge, blocked file/mixed-content navigation, denied web permissions, TLS refusal and native confirmation bound the native surface. Same-origin web XSS remains a web risk; this does not claim JavaScript is risk-free. |

**Current lint: 0 errors / 3 unsuppressed warnings.**

- `SetJavaScriptEnabled`: reviewed above; necessary for the shared dashboard. Not suppressed.
- `OldTargetApi`: target 35 retained; compiling with 36 does not opt into Android 16 runtime behavior. Target changes need OS/device regression checks, not a blanket version bump to silence lint. This APK is not a Play release.
- `AndroidGradlePluginVersion`: newer Gradle exists; 8.11.1 is the documented compatible version for AGP 8.10/API 36 and JDK 17. Toolchain updates are ongoing maintenance, not an unresolved access grant.

New API-31 compatibility errors caught while adding authentication were corrected using supported String charset overloads. Strict callback parsing rejects duplicate/trailing query parameters. Cookie validation checks exact `HttpOnly`, `Secure`, root Path and no Domain; cancellation removes only the matching newly installed cookie. Renderer death has an explicit offline fallback and keeps native alarms independent. WebView/auth are not direct-boot aware; native alarm components remain so. Modern Back dispatch, system/keyboard insets, live feedback and ≥48dp native action controls are included. Editor validation focuses its error field.

No accessibility-specific lint warning appeared in the original 37 or the final 3. That is **not** a TalkBack/accessibility certification. Keyboard/ARIA behavior is checked in browser QA; actual Android TalkBack, font scaling, lock-screen, back, image picker, Auth Tab, audio and device reliability still require approved physical-device testing. No warning baseline, `abortOnError=false`, or security-warning suppression was added.
