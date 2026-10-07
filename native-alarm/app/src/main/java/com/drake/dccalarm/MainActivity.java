package com.drake.dccalarm;

import android.app.*;
import android.content.*;
import android.net.Uri;
import android.net.http.SslError;
import android.os.*;
import android.view.*;
import android.webkit.*;
import android.widget.*;
import androidx.webkit.*;
import org.json.*;

/** Shared DCC dashboard with offline native alarms. No JavaScript interface. */
public final class MainActivity extends Activity {
  private WebView web;
  private TextView status;
  private FrameLayout page;
  private TextView offline;
  private ValueCallback<Uri[]> fileCallback;

  public void onCreate(Bundle state) {
    super.onCreate(state);
    LinearLayout root = new LinearLayout(this);
    root.setOrientation(LinearLayout.VERTICAL);
    root.setOnApplyWindowInsetsListener(
        (view, insets) -> {
          android.graphics.Insets safe =
              insets.getInsets(
                  WindowInsets.Type.systemBars()
                      | WindowInsets.Type.displayCutout()
                      | WindowInsets.Type.ime());
          view.setPadding(safe.left, safe.top, safe.right, safe.bottom);
          return WindowInsets.CONSUMED;
        });
    LinearLayout bar = new LinearLayout(this);
    Button home = new Button(this);
    home.setText("DCC");
    home.setMinHeight(dp(48));
    home.setOnClickListener(v -> web.loadUrl(OriginPolicy.ORIGIN));
    bar.addView(home);
    Button alarms = new Button(this);
    alarms.setText("Device alarms");
    alarms.setMinHeight(dp(48));
    alarms.setOnClickListener(v -> startActivity(new Intent(this, AlarmActivity.class)));
    bar.addView(alarms);
    Button reload = new Button(this);
    reload.setText("Reload");
    reload.setMinHeight(dp(48));
    reload.setOnClickListener(v -> web.reload());
    bar.addView(reload);
    root.addView(bar);
    status = new TextView(this);
    status.setPadding(dp(12), dp(4), dp(12), dp(4));
    status.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
    root.addView(status);
    page = new FrameLayout(this);
    root.addView(page, new LinearLayout.LayoutParams(-1, 0, 1));
    web = new WebView(this);
    page.addView(web, new FrameLayout.LayoutParams(-1, -1));
    offline = new TextView(this);
    offline.setText("Dashboard unavailable. Device alarms work offline. Tap Reload to retry.");
    offline.setPadding(dp(24), dp(32), dp(24), dp(24));
    offline.setBackgroundColor(0xff151924);
    offline.setVisibility(View.GONE);
    page.addView(offline, new FrameLayout.LayoutParams(-1, -1));
    setContentView(root);
    root.requestApplyInsets();
    WebSettings settings = web.getSettings();
    settings.setJavaScriptEnabled(true);
    settings.setDomStorageEnabled(true);
    settings.setUserAgentString(settings.getUserAgentString() + " DCCAndroid/0.2");
    settings.setAllowFileAccess(false);
    settings.setAllowContentAccess(false);
    settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
    settings.setMediaPlaybackRequiresUserGesture(true);
    settings.setSafeBrowsingEnabled(true);
    settings.setSupportMultipleWindows(true);
    settings.setJavaScriptCanOpenWindowsAutomatically(false);
    CookieManager.getInstance().setAcceptThirdPartyCookies(web, false);
    web.setWebViewClient(
        new WebViewClient() {
          public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            if (!request.isForMainFrame())
              return !OriginPolicy.external(request.getUrl().toString());
            String url = request.getUrl().toString();
            if (OriginPolicy.trusted(url)) return false;
            offerExternal(url);
            return true;
          }

          public void onPageStarted(WebView view, String url, android.graphics.Bitmap icon) {
            offline.setVisibility(View.GONE);
            if (!OriginPolicy.trusted(url)) {
              view.stopLoading();
              offline.setVisibility(View.VISIBLE);
            }
          }

          public void onReceivedError(WebView v, WebResourceRequest r, WebResourceError e) {
            if (r.isForMainFrame()) offline.setVisibility(View.VISIBLE);
          }

          public void onReceivedHttpError(WebView v, WebResourceRequest r, WebResourceResponse e) {
            if (r.isForMainFrame() && e.getStatusCode() >= 500) offline.setVisibility(View.VISIBLE);
          }

          public void onReceivedSslError(WebView v, SslErrorHandler h, SslError e) {
            h.cancel();
            offline.setVisibility(View.VISIBLE);
          }
        });
    web.setWebChromeClient(
        new WebChromeClient() {
          public boolean onShowFileChooser(
              WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
            if (!OriginPolicy.trusted(view.getUrl())) return false;
            if (fileCallback != null) fileCallback.onReceiveValue(null);
            fileCallback = callback;
            Intent picker =
                new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE);
            String[] types = params.getAcceptTypes();
            picker.setType(types.length == 1 && "image/*".equals(types[0]) ? "image/*" : "*/*");
            picker.putExtra(
                Intent.EXTRA_ALLOW_MULTIPLE,
                params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE);
            try {
              startActivityForResult(picker, 90);
            } catch (ActivityNotFoundException e) {
              fileCallback.onReceiveValue(null);
              fileCallback = null;
              status.setText("No document picker available");
            }
            return true;
          }

          public void onPermissionRequest(PermissionRequest request) {
            request.deny();
          }

          public void onGeolocationPermissionsShowPrompt(
              String origin, GeolocationPermissions.Callback callback) {
            callback.invoke(origin, false, false);
          }

          public boolean onCreateWindow(
              WebView v, boolean dialog, boolean gesture, Message result) {
            // No second browsing surface inherits a native bridge. Providers may use redirects
            // instead.
            new AlertDialog.Builder(MainActivity.this)
                .setMessage(
                    "This sign-in opens a new window. Use the username/email login in DCC; browser"
                        + " OAuth handoff is not configured yet.")
                .setPositiveButton("OK", null)
                .show();
            return false;
          }
        });
    if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
      WebViewCompat.addWebMessageListener(
          web,
          "DCCNativeAlarms",
          java.util.Set.of(OriginPolicy.ORIGIN),
          (view, message, origin, mainFrame, reply) -> {
            if (!OriginPolicy.bridgeAllowed(origin.toString(), mainFrame, view.getUrl())) return;
            try {
              if (message.getType() != WebMessageCompat.TYPE_STRING) return;
              String data = message.getData();
              if (data == null || data.length() > 65536) return;
              JSONObject request = new JSONObject(data);
              String action = request.optString("action");
              if ("status".equals(action)) {
                try (AlarmDb db = new AlarmDb(this)) {
                  reply.postMessage(
                      new JSONObject()
                          .put("version", 1)
                          .put("status", db.status())
                          .put("deviceLocal", true)
                          .toString());
                }
              } else if ("open".equals(action))
                startActivity(new Intent(this, AlarmActivity.class));
              else if ("review".equals(action)) {
                JSONArray definitions = request.getJSONArray("alarms");
                if (definitions.length() > 20)
                  throw new IllegalArgumentException("Maximum 20 alarms");
                startActivity(
                    new Intent(this, AlarmActivity.class)
                        .putExtra("reviewDefinitions", definitions.toString()));
              }
            } catch (Exception ignored) {
              reply.postMessage("{\"error\":\"Invalid alarm request\"}");
            }
          });
    }
    // Never restore a caller URL or browser history from an Intent/Bundle.
    web.loadUrl(OriginPolicy.ORIGIN);
  }

  private int dp(int value) {
    return Math.round(value * getResources().getDisplayMetrics().density);
  }

  private void offerExternal(String url) {
    if (!OriginPolicy.external(url)) return;
    new AlertDialog.Builder(this)
        .setTitle("Open external browser?")
        .setMessage(
            "Leaving DCC for "
                + Uri.parse(url).getHost()
                + ". External browser sign-in does not automatically sign this app in. Device"
                + " alarms continue independently.")
        .setNegativeButton("Stay here", null)
        .setPositiveButton(
            "Open browser",
            (d, w) -> {
              try {
                startActivity(
                    new Intent(Intent.ACTION_VIEW, Uri.parse(url))
                        .addCategory(Intent.CATEGORY_BROWSABLE));
              } catch (ActivityNotFoundException e) {
                status.setText("No browser available");
              }
            })
        .show();
  }

  protected void onResume() {
    super.onResume();
    AlarmScheduler.reconcile(this);
    try (AlarmDb db = new AlarmDb(this)) {
      long next = 0;
      for (JSONObject a : db.definitions()) {
        long at = a.optLong("nextAt");
        if (at > 0 && (next == 0 || at < next)) next = at;
      }
      status.setText(
          "Phone alarms · "
              + db.status()
              + (next > 0
                  ? " · Next "
                      + java.time.Instant.ofEpochMilli(next)
                          .atZone(java.time.ZoneId.systemDefault())
                  : "")
              + " · shared across DCC accounts");
    } catch (Exception e) {
      status.setText("Phone alarm state unavailable. Open Device alarms.");
    }
  }

  protected void onActivityResult(int request, int result, Intent data) {
    super.onActivityResult(request, result, data);
    if (request != 90 || fileCallback == null) return;
    java.util.ArrayList<Uri> chosen = new java.util.ArrayList<>();
    if (result == RESULT_OK && data != null && OriginPolicy.trusted(web.getUrl())) {
      if (data.getClipData() != null) {
        for (int i = 0; i < Math.min(10, data.getClipData().getItemCount()); i++) {
          Uri uri = data.getClipData().getItemAt(i).getUri();
          if ("content".equals(uri.getScheme())) chosen.add(uri);
        }
      } else if (data.getData() != null && "content".equals(data.getData().getScheme()))
        chosen.add(data.getData());
    }
    fileCallback.onReceiveValue(chosen.isEmpty() ? null : chosen.toArray(new Uri[0]));
    fileCallback = null;
  }

  public void onBackPressed() {
    if (web.canGoBack()) web.goBack();
    else super.onBackPressed();
  }

  protected void onDestroy() {
    if (fileCallback != null) fileCallback.onReceiveValue(null);
    web.destroy();
    super.onDestroy();
  }
}
