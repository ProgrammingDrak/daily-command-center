package com.drake.dccalarm;

import static org.junit.Assert.*;

import java.util.Set;
import org.json.*;
import org.junit.*;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 31)
public class EventAlarmRulesTest {
  final long now = 1791460800000L;

  JSONObject link() throws Exception {
    return new JSONObject()
        .put("workspaceId", "ws-1")
        .put("blockId", "stable-1")
        .put("title", "Meeting")
        .put("sourceZone", "America/New_York")
        .put("startAt", now + 3600000)
        .put("offsetMinutes", 5)
        .put("checkedAt", now)
        .put("validUntil", now + EventAlarmRules.MAX_AGE)
        .put("state", "ready");
  }

  JSONObject alarm() throws Exception {
    return new JSONObject()
        .put("id", "a")
        .put("label", "Meeting")
        .put("date", "2026-10-08")
        .put("time", "13:00")
        .put("mode", "once")
        .put("days", new JSONArray())
        .put("challenge", "math")
        .put("difficulty", "easy")
        .put("count", 3)
        .put("enabled", true)
        .put("volume", 0.15)
        .put("snoozes", 0)
        .put("eventLink", link());
  }

  @Before
  public void reset() {
    RuntimeEnvironment.getApplication()
        .createDeviceProtectedStorageContext()
        .deleteDatabase("alarms.db");
  }

  @Test
  public void boundedSnapshotAndOneOccurrence() throws Exception {
    JSONObject a = alarm();
    AlarmDb.validate(a);
    ClockRules.Occurrence o = EventAlarmRules.next(a, now, Set.of());
    assertEquals(now + 3300000, o.at());
    assertEquals("a/event", o.key());
    assertNull(EventAlarmRules.next(a, now, Set.of(o.key())));
    assertNull(EventAlarmRules.next(a, now - 60001, Set.of()));
    assertNull(EventAlarmRules.next(a, now + EventAlarmRules.MAX_AGE + 1, Set.of()));
    a.getJSONObject("eventLink").put("startAt", now + EventAlarmRules.MAX_AGE + 300001);
    assertNull(EventAlarmRules.next(a, now, Set.of()));
  }

  @Test
  public void reschedulePersistsAndDuplicateDeliveryRefused() throws Exception {
    try (AlarmDb db = new AlarmDb(RuntimeEnvironment.getApplication())) {
      db.importDefinitions(new JSONArray().put(alarm()));
      JSONObject moved = link().put("startAt", now + 7200000);
      assertFalse(db.syncEvent(moved, now));
      JSONObject a = db.definitions().get(0);
      assertEquals(now + 6900000, EventAlarmRules.next(a, now, db.consumed()).at());
      db.scheduled("a", now + 6900000, "a/event");
      assertTrue(db.receive("a", "a/event", now + 6900000));
      assertFalse(db.receive("a", "a/event", now + 6900000));
      assertFalse(db.syncEvent(moved.put("startAt", now + 10800000), now));
      assertNotNull(db.active());
      assertNull(EventAlarmRules.next(db.definitions().get(0), now, db.consumed()));
    }
  }

  @Test
  public void cancellationStopsQuizAndRecoveryNeverEnables() throws Exception {
    try (AlarmDb db = new AlarmDb(RuntimeEnvironment.getApplication())) {
      db.importDefinitions(new JSONArray().put(alarm()));
      db.scheduled("a", now + 3300000, "a/event");
      assertTrue(db.receive("a", "a/event", now + 3300000));
      assertTrue(db.syncEvent(link().put("state", "unavailable"), now));
      assertNull(db.active());
      assertFalse(db.definitions().get(0).getBoolean("enabled"));
      db.syncEvent(link(), now);
      assertFalse(db.definitions().get(0).getBoolean("enabled"));
    }
  }

  @Test
  public void wrongScopeUnknownAndOlderSnapshotsDoNotModify() throws Exception {
    try (AlarmDb db = new AlarmDb(RuntimeEnvironment.getApplication())) {
      db.importDefinitions(new JSONArray().put(alarm()));
      db.syncEvent(link().put("workspaceId", "ws-2").put("state", "unavailable"), now);
      assertTrue(db.definitions().get(0).getBoolean("enabled"));
      db.syncEvent(link().put("blockId", "other"), now);
      assertEquals(1, db.definitions().size());
      db.syncEvent(
          link()
              .put("checkedAt", now - 1000)
              .put("validUntil", now - 1000 + EventAlarmRules.MAX_AGE)
              .put("state", "unavailable"),
          now);
      assertTrue(db.definitions().get(0).getBoolean("enabled"));
    }
  }

  @Test
  public void duplicateLinksAndMalformedNumbersReject() throws Exception {
    try (AlarmDb db = new AlarmDb(RuntimeEnvironment.getApplication())) {
      JSONObject other = alarm().put("id", "b");
      assertThrows(
          IllegalArgumentException.class,
          () -> db.importDefinitions(new JSONArray().put(alarm()).put(other)));
    }
    JSONObject l = link().put("offsetMinutes", 1.5);
    assertThrows(IllegalArgumentException.class, () -> EventAlarmRules.validate(l));
  }

  @Test
  public void staleReceiveIsSilentAndIndependentAlarmUnaffected() throws Exception {
    try (AlarmDb db = new AlarmDb(RuntimeEnvironment.getApplication())) {
      JSONObject independent = alarm().put("id", "independent");
      independent.remove("eventLink");
      db.importDefinitions(new JSONArray().put(alarm()).put(independent));
      db.scheduled("a", now + EventAlarmRules.MAX_AGE + 1, "a/event");
      assertFalse(db.receive("a", "a/event", now + EventAlarmRules.MAX_AGE + 1));
      db.syncEvent(link().put("state", "unavailable"), now);
      assertTrue(
          db.definitions().stream()
              .filter(x -> x.optString("id").equals("independent"))
              .findFirst()
              .get()
              .getBoolean("enabled"));
    }
  }

  @Test
  public void nativeReviewUpsertsOneDisabledLinkAndPreservesIndependent() throws Exception {
    android.app.Application context = RuntimeEnvironment.getApplication();
    JSONObject independent = alarm().put("id", "independent");
    independent.remove("eventLink");
    try (AlarmDb db = new AlarmDb(context)) {
      db.importDefinitions(new JSONArray().put(alarm()).put(independent));
    }
    JSONObject proposed = alarm().put("id", "new-proposal").put("enabled", false);
    proposed.getJSONObject("eventLink").put("offsetMinutes", 10);
    android.content.Intent intent =
        new android.content.Intent(context, AlarmActivity.class)
            .putExtra("reviewEvent", proposed.toString());
    org.robolectric.android.controller.ActivityController<AlarmActivity> controller =
        org.robolectric.Robolectric.buildActivity(AlarmActivity.class, intent)
            .create()
            .start()
            .resume();
    android.app.AlertDialog dialog =
        org.robolectric.shadows.ShadowAlertDialog.getLatestAlertDialog();
    assertNotNull(dialog);
    dialog.getButton(android.content.DialogInterface.BUTTON_POSITIVE).performClick();
    org.robolectric.shadows.ShadowLooper.runUiThreadTasks();
    try (AlarmDb db = new AlarmDb(context)) {
      assertEquals(2, db.definitions().size());
      JSONObject linked =
          db.definitions().stream().filter(x -> x.has("eventLink")).findFirst().get();
      assertEquals("a", linked.getString("id"));
      assertFalse(linked.getBoolean("enabled"));
      assertEquals(10, linked.getJSONObject("eventLink").getInt("offsetMinutes"));
      assertTrue(
          db.definitions().stream()
              .filter(x -> x.optString("id").equals("independent"))
              .findFirst()
              .get()
              .getBoolean("enabled"));
    }
    controller.pause().stop().destroy();
  }
}
