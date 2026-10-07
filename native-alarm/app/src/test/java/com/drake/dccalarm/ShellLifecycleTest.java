package com.drake.dccalarm;

import static org.junit.Assert.*;

import android.content.*;
import android.webkit.WebView;
import android.widget.*;
import org.json.*;
import org.junit.*;
import org.junit.runner.RunWith;
import org.robolectric.*;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 31)
public class ShellLifecycleTest {
  @Before
  public void clean() {
    RuntimeEnvironment.getApplication()
        .createDeviceProtectedStorageContext()
        .deleteDatabase("alarms.db");
  }

  @Test
  public void dashboardUsesFixedOriginAndDoesNotEnrollPermissions() {
    MainActivity activity =
        Robolectric.buildActivity(
                MainActivity.class, new Intent().putExtra("url", "https://evil.test"))
            .setup()
            .get();
    LinearLayout root =
        (LinearLayout)
            ((android.view.ViewGroup) activity.findViewById(android.R.id.content)).getChildAt(0);
    android.widget.FrameLayout page = (android.widget.FrameLayout) root.getChildAt(2);
    WebView web = (WebView) page.getChildAt(0);
    assertEquals(OriginPolicy.ORIGIN, Shadows.shadowOf(web).getLastLoadedUrl());
    assertFalse(web.getSettings().getAllowFileAccess());
    assertFalse(web.getSettings().getAllowContentAccess());
    assertTrue(web.getSettings().getMediaPlaybackRequiresUserGesture());
    assertNull(Shadows.shadowOf(activity).getLastRequestedPermission());
  }

  @Test
  public void nativeAlarmScreenWorksWithoutDashboardAndCancelKeepsDefinitions() throws Exception {
    AlarmActivity activity = Robolectric.buildActivity(AlarmActivity.class).setup().get();
    android.widget.ScrollView scroll =
        (android.widget.ScrollView)
            ((android.view.ViewGroup) activity.findViewById(android.R.id.content)).getChildAt(0);
    LinearLayout body = (LinearLayout) scroll.getChildAt(0);
    Button add = null;
    for (int i = 0; i < body.getChildCount(); i++)
      if (body.getChildAt(i) instanceof Button
          && ((Button) body.getChildAt(i)).getText().toString().equals("Add phone alarm"))
        add = (Button) body.getChildAt(i);
    assertNotNull(add);
    add.performClick();
    android.app.AlertDialog dialog =
        org.robolectric.shadows.ShadowAlertDialog.getLatestAlertDialog();
    assertTrue(dialog.isShowing());
    dialog.getButton(android.app.AlertDialog.BUTTON_NEGATIVE).performClick();
    try (AlarmDb db = new AlarmDb(activity)) {
      assertEquals(0, db.definitions().size());
    }
    assertNull(Shadows.shadowOf(activity).getLastRequestedPermission());
  }

  @Test
  public void dashboardLogoutOrSwitchCannotClearNativeAlarmProgress() throws Exception {
    Context context = RuntimeEnvironment.getApplication();
    JSONObject alarm =
        new JSONObject(
            "{\"id\":\"phone\",\"label\":\"Local\",\"date\":\"2026-10-07\",\"time\":\"07:00\",\"mode\":\"once\",\"days\":[],\"enabled\":true,\"challenge\":\"math\",\"difficulty\":\"easy\",\"count\":3,\"volume\":0.15,\"snoozes\":0}");
    try (AlarmDb db = new AlarmDb(context)) {
      db.importDefinitions(new JSONArray().put(alarm));
      db.scheduled("phone", 1000, "phone/2026-10-07");
      assertTrue(db.receive("phone", "phone/2026-10-07", 1000));
    }
    android.webkit.CookieManager.getInstance().removeAllCookies(null);
    try (AlarmDb db = new AlarmDb(context)) {
      assertNotNull(db.active());
      assertEquals(1, db.definitions().size());
    }
  }

  @Test
  public void phoneEditorRequiresReviewBeforeSavingAndDefaultsDisabled() throws Exception {
    AlarmActivity activity = Robolectric.buildActivity(AlarmActivity.class).setup().get();
    android.widget.ScrollView scroll =
        (android.widget.ScrollView)
            ((android.view.ViewGroup) activity.findViewById(android.R.id.content)).getChildAt(0);
    LinearLayout body = (LinearLayout) scroll.getChildAt(0);
    for (int i = 0; i < body.getChildCount(); i++)
      if (body.getChildAt(i) instanceof Button
          && ((Button) body.getChildAt(i)).getText().toString().equals("Add phone alarm"))
        body.getChildAt(i).performClick();
    android.app.AlertDialog editor =
        org.robolectric.shadows.ShadowAlertDialog.getLatestAlertDialog();
    Shadows.shadowOf(android.os.Looper.getMainLooper()).idle();
    editor.getButton(android.app.AlertDialog.BUTTON_POSITIVE).performClick();
    Shadows.shadowOf(android.os.Looper.getMainLooper()).idle();
    try (AlarmDb db = new AlarmDb(activity)) {
      assertEquals(0, db.definitions().size());
    }
    android.app.AlertDialog review =
        org.robolectric.shadows.ShadowAlertDialog.getLatestAlertDialog();
    assertNotSame(editor, review);
    review.getButton(android.app.AlertDialog.BUTTON_POSITIVE).performClick();
    Shadows.shadowOf(android.os.Looper.getMainLooper()).idle();
    try (AlarmDb db = new AlarmDb(activity)) {
      assertEquals(1, db.definitions().size());
      assertFalse(db.definitions().get(0).getBoolean("enabled"));
      assertEquals(3, db.definitions().get(0).getInt("count"));
    }
    assertNull(Shadows.shadowOf(activity).getLastRequestedPermission());
  }
}
