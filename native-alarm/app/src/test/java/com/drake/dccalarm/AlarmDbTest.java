package com.drake.dccalarm;

import static org.junit.Assert.*;

import android.content.Context;
import org.json.*;
import org.junit.*;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 31)
public class AlarmDbTest {
  Context c;
  JSONObject a;

  @Before
  public void prepare() throws Exception {
    c = RuntimeEnvironment.getApplication();
    c.createDeviceProtectedStorageContext().deleteDatabase("alarms.db");
    a =
        new JSONObject(
            "{\"id\":\"a\",\"label\":\"Wake\",\"date\":\"2026-10-07\",\"time\":\"07:00\",\"mode\":\"once\",\"days\":[],\"enabled\":true,\"challenge\":\"math\",\"difficulty\":\"easy\",\"count\":3,\"volume\":0.15,\"snoozes\":0}");
  }

  @Test
  public void persistenceDuplicateProgressAndEmergency() throws Exception {
    try (AlarmDb db = new AlarmDb(c)) {
      db.importDefinitions(new JSONArray().put(a));
      db.scheduled("a", 1000, "a/2026-10-07");
      assertTrue(db.receive("a", "a/2026-10-07", 1000));
      assertFalse(db.receive("a", "a/2026-10-07", 1000));
      assertFalse(db.answer("a/2026-10-07", "2e1"));
      JSONObject r = db.active();
      assertEquals(0, r.getInt("index"));
      assertTrue(
          db.answer(
              r.getString("key"),
              r.getJSONArray("questions").getJSONObject(0).getString("answer")));
    }
    try (AlarmDb db = new AlarmDb(c)) {
      assertEquals(1, db.active().getInt("index"));
      db.stopAll();
      assertNull(db.active());
      assertTrue(db.consumed().contains("a/2026-10-07"));
      assertFalse(db.receive("a", "a/2026-10-07", 1000));
    }
  }

  @Test
  public void completionAdvancesQueueAtomically() throws Exception {
    try (AlarmDb db = new AlarmDb(c)) {
      JSONObject b = new JSONObject(a.toString()).put("id", "b");
      db.importDefinitions(new JSONArray().put(a).put(b));
      db.scheduled("a", 1000, "a/2026-10-07");
      db.scheduled("b", 1000, "b/2026-10-07");
      assertTrue(db.receive("a", "a/2026-10-07", 1000));
      assertTrue(db.receive("b", "b/2026-10-07", 1000));
      for (int i = 0; i < 3; i++) {
        JSONObject r = db.active();
        assertEquals("a/2026-10-07", r.getString("key"));
        assertTrue(
            db.answer(
                r.getString("key"),
                r.getJSONArray("questions").getJSONObject(i).getString("answer")));
      }
      assertEquals("b/2026-10-07", db.active().getString("key"));
      assertFalse(db.receive("a", "a/2026-10-07", 1000));
    }
  }

  @Test
  public void malformedImportNeverReplacesSavedDefinition() throws Exception {
    try (AlarmDb db = new AlarmDb(c)) {
      db.importDefinitions(new JSONArray().put(a));
      JSONObject bad = new JSONObject(a.toString()).put("count", 100);
      try {
        db.importDefinitions(new JSONArray().put(bad));
        fail();
      } catch (IllegalArgumentException expected) {
      }
      assertEquals(3, db.definitions().get(0).getInt("count"));
    }
  }

  @Test
  public void staleEarlyAndLateDeliveryDoNotRing() throws Exception {
    try (AlarmDb db = new AlarmDb(c)) {
      db.importDefinitions(new JSONArray().put(a));
      db.scheduled("a", 1000, "a/2026-10-07");
      assertFalse(db.receive("a", "a/2026-10-06", 1000));
      assertFalse(db.receive("a", "a/2026-10-07", 999));
      assertFalse(db.consumed().contains("a/2026-10-07"));
      assertFalse(db.receive("a", "a/2026-10-07", 62000));
      assertNull(db.active());
      assertTrue(db.consumed().contains("a/2026-10-07"));
    }
  }

  @Test
  public void pendingImportRefusedAndDisableCancelsChallenge() throws Exception {
    try (AlarmDb db = new AlarmDb(c)) {
      db.importDefinitions(new JSONArray().put(a));
      db.scheduled("a", 1000, "a/2026-10-07");
      db.receive("a", "a/2026-10-07", 1000);
      try {
        db.importDefinitions(new JSONArray());
        fail();
      } catch (IllegalStateException expected) {
      }
      assertEquals(1, db.definitions().size());
      db.toggle("a");
      assertNull(db.active());
      assertFalse(db.definitions().get(0).getBoolean("enabled"));
    }
  }

  @Test
  public void permissionDenialNeverClaimsArmed() {
    org.robolectric.Shadows.shadowOf(c.getSystemService(android.app.AlarmManager.class))
        .setCanScheduleExactAlarms(false);
    AlarmScheduler.reconcile(c);
    try (AlarmDb db = new AlarmDb(c)) {
      assertTrue(db.status().startsWith("Not armed:"));
    }
  }
}
