package com.drake.dccalarm;

import android.app.*;
import android.content.*;
import android.content.pm.verify.domain.*;
import android.net.Uri;
import android.os.*;
import android.webkit.CookieManager;
import androidx.activity.result.ActivityResultLauncher;
import androidx.browser.auth.AuthTabIntent;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import org.json.*;

/** Browser sign-in + verified HTTPS return + one-use PKCE session exchange. No provider secrets. */
final class NativeAuth {
  interface Result {
    void message(String text);

    void signedIn();
  }

  private final Activity activity;
  private final Result result;
  private final ActivityResultLauncher<Intent> launcher;
  private String state, verifier;
  private long started, generation;
  private boolean busy;

  NativeAuth(Activity activity, ActivityResultLauncher<Intent> launcher, Result result) {
    this.activity = activity;
    this.launcher = launcher;
    this.result = result;
  }

  private boolean verified() {
    DomainVerificationManager manager = activity.getSystemService(DomainVerificationManager.class);
    try {
      DomainVerificationUserState user =
          manager.getDomainVerificationUserState(activity.getPackageName());
      return user != null
          && user.isLinkHandlingAllowed()
          && Objects.equals(
              user.getHostToStateMap().get(Uri.parse(OriginPolicy.ORIGIN).getHost()),
              DomainVerificationUserState.DOMAIN_STATE_VERIFIED);
    } catch (Exception e) {
      return false;
    }
  }

  boolean hasPendingAttempt() {
    return state != null;
  }

  void cancel() {
    generation++;
    state = null;
    verifier = null;
    busy = false;
  }

  void begin() {
    if (busy) return;
    cancel();
    if (!verified()) {
      result.message(
          activity.getString(R.string.ui_google_sign_in_is_not_ready_this_signed_app_mu_1baef));
      return;
    }
    busy = true;
    long attempt = generation;
    result.message(activity.getString(R.string.ui_checking_browser_sign_in_availability_40c1d));
    new Thread(
            () -> {
              boolean enabled = false;
              try {
                JSONObject config = new JSONObject(request("/api/auth/android/config", null).body);
                enabled =
                    config.optBoolean("enabled")
                        && config.optInt("version") == 1
                        && activity.getPackageName().equals(config.optString("packageName"));
              } catch (Exception ignored) {
              }
              boolean ready = enabled;
              activity.runOnUiThread(
                  () -> {
                    if (activity.isDestroyed() || generation != attempt) return;
                    busy = false;
                    if (!ready) {
                      result.message(
                          activity.getString(
                              R.string.ui_google_sign_in_is_not_released_on_the_dcc_serv_81c5c));
                      return;
                    }
                    state = NativeAuthRules.token();
                    verifier = NativeAuthRules.token();
                    started = SystemClock.elapsedRealtime();
                    Uri url =
                        Uri.parse(OriginPolicy.ORIGIN + "/auth/android/authorize")
                            .buildUpon()
                            .appendQueryParameter("state", state)
                            .appendQueryParameter("challenge", NativeAuthRules.challenge(verifier))
                            .build();
                    try {
                      new AuthTabIntent.Builder()
                          .build()
                          .launch(
                              launcher,
                              url,
                              Uri.parse(OriginPolicy.ORIGIN).getHost(),
                              "/auth/android/callback");
                      result.message(
                          activity.getString(
                              R.string.ui_complete_google_sign_in_in_the_browser_and_con_c1f8a));
                    } catch (ActivityNotFoundException e) {
                      cancel();
                      result.message(
                          activity.getString(
                              R.string.ui_no_browser_available_no_session_was_transferre_943c5));
                    }
                  });
            },
            "dcc-auth-config")
        .start();
  }

  boolean handle(Intent intent) {
    if (intent.getData() == null) return false;
    String code =
        NativeAuthRules.code(
            intent.getData().toString(),
            state,
            verified(),
            SystemClock.elapsedRealtime() - started);
    intent.setData(null); // No code kept in the Activity's Intent/history.
    if (code == null) {
      result.message(
          activity.getString(R.string.ui_android_sign_in_return_was_refused_or_expired__e1ddc));
      return true;
    }
    String exchangeState = state, exchangeVerifier = verifier;
    long attempt = generation;
    state = null;
    verifier = null;
    busy = true;
    result.message(activity.getString(R.string.ui_completing_dcc_sign_in_1a552));
    new Thread(
            () -> {
              String cookie = null;
              try {
                Response response =
                    request(
                        "/api/auth/android/exchange",
                        new JSONObject()
                            .put("code", code)
                            .put("state", exchangeState)
                            .put("verifier", exchangeVerifier)
                            .toString());
                if (new JSONObject(response.body).optBoolean("ok"))
                  for (String value : response.cookies) {
                    if (NativeAuthRules.sessionCookie(value)) cookie = value;
                  }
              } catch (Exception ignored) {
              }
              String confirmedCookie = cookie;
              activity.runOnUiThread(
                  () -> {
                    if (activity.isDestroyed() || generation != attempt) return;
                    busy = false;
                    if (confirmedCookie == null) {
                      result.message(
                          activity.getString(
                              R.string.ui_dcc_sign_in_failed_safely_start_again_device_a_4809e));
                      return;
                    }
                    CookieManager.getInstance()
                        .setCookie(
                            OriginPolicy.ORIGIN,
                            confirmedCookie,
                            accepted -> {
                              if (activity.isDestroyed() || generation != attempt) {
                                String current =
                                    CookieManager.getInstance().getCookie(OriginPolicy.ORIGIN);
                                if (NativeAuthRules.currentCookieMatches(
                                    current, confirmedCookie)) {
                                  CookieManager.getInstance()
                                      .setCookie(
                                          OriginPolicy.ORIGIN,
                                          "dcc_session=; Path=/; Secure; HttpOnly; Max-Age=0",
                                          null);
                                }
                                return;
                              }
                              if (Boolean.TRUE.equals(accepted)) {
                                CookieManager.getInstance().flush();
                                result.message(
                                    activity.getString(
                                        R.string
                                            .ui_dcc_signed_in_device_alarms_are_unchanged_12175));
                                result.signedIn();
                              } else
                                result.message(
                                    activity.getString(
                                        R.string
                                            .ui_dcc_could_not_save_its_session_cookie_start_si_b96a9));
                            });
                  });
            },
            "dcc-auth-exchange")
        .start();
    return true;
  }

  private record Response(String body, List<String> cookies) {}

  private static Response request(String path, String body) throws Exception {
    HttpURLConnection connection =
        (HttpURLConnection) new URL(OriginPolicy.ORIGIN + path).openConnection();
    connection.setInstanceFollowRedirects(false);
    connection.setConnectTimeout(15000);
    connection.setReadTimeout(15000);
    connection.setRequestProperty("Accept", "application/json");
    try {
      if (body != null) {
        connection.setRequestMethod("POST");
        connection.setDoOutput(true);
        connection.setRequestProperty("Content-Type", "application/json");
        try (OutputStream out = connection.getOutputStream()) {
          out.write(body.getBytes(StandardCharsets.UTF_8));
        }
      }
      if (connection.getResponseCode() != 200) throw new IOException("Sign-in unavailable");
      ByteArrayOutputStream bytes = new ByteArrayOutputStream();
      try (InputStream input = connection.getInputStream()) {
        byte[] buffer = new byte[1024];
        int n;
        while ((n = input.read(buffer)) != -1) {
          if (bytes.size() + n > 4096) throw new IOException("Invalid response");
          bytes.write(buffer, 0, n);
        }
      }
      List<String> cookies = new ArrayList<>();
      for (Map.Entry<String, List<String>> entry : connection.getHeaderFields().entrySet())
        if ("set-cookie".equalsIgnoreCase(entry.getKey())) cookies.addAll(entry.getValue());
      return new Response(new String(bytes.toByteArray(), StandardCharsets.UTF_8), cookies);
    } finally {
      connection.disconnect();
    }
  }
}
