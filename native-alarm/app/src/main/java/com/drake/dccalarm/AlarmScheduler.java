package com.drake.dccalarm;

import android.Manifest;
import android.app.*;
import android.content.*;
import android.content.pm.PackageManager;
import android.media.AudioManager;
import android.os.Build;
import java.time.ZoneId;
import java.util.*;
import org.json.*;

public final class AlarmScheduler {
  public static final String CHANNEL = "dcc-alarm-v1";

  public static NotificationManager notifications(Context c) {
    return c.getSystemService(NotificationManager.class);
  }

  public static void channel(Context c) {
    NotificationChannel ch =
        new NotificationChannel(CHANNEL, "Wake-up alarms", NotificationManager.IMPORTANCE_HIGH);
    ch.setSound(null, null);
    notifications(c).createNotificationChannel(ch);
  }

  public static String unavailable(Context c) {
    AlarmManager am = c.getSystemService(AlarmManager.class);
    if (!am.canScheduleExactAlarms())
      return "Exact alarm access is missing. Enable it explicitly in settings.";
    if (Build.VERSION.SDK_INT >= 33
        && c.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
            != PackageManager.PERMISSION_GRANTED) return "Notifications are denied.";
    NotificationManager nm = notifications(c);
    if (!nm.areNotificationsEnabled()) return "Notifications are disabled.";
    if (Build.VERSION.SDK_INT >= 34 && !nm.canUseFullScreenIntent())
      return "Lock-screen alarm access is unavailable.";
    NotificationChannel ch = nm.getNotificationChannel(CHANNEL);
    if (ch == null || ch.getImportance() < NotificationManager.IMPORTANCE_HIGH)
      return "Alarm channel must allow high-priority alerts.";
    if (c.getSystemService(AudioManager.class).getStreamVolume(AudioManager.STREAM_ALARM) == 0)
      return "System alarm volume is muted.";
    return "";
  }

  static PendingIntent delivery(Context c, String id, String key, String action) {
    Intent i =
        new Intent(c, AlarmReceiver.class)
            .setAction(action)
            .setData(
                android.net.Uri.parse("dccalarm://" + action + "/" + android.net.Uri.encode(id)))
            .putExtra("id", id)
            .putExtra("key", key);
    return PendingIntent.getBroadcast(
        c, 0, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
  }

  public static void cancel(Context c, String id) {
    c.getSystemService(AlarmManager.class).cancel(delivery(c, id, "", "FIRE"));
  }

  public static synchronized void reconcile(Context c) {
    reconcile(c, false);
  }

  public static synchronized void reconcile(Context c, boolean recovery) {
    channel(c);
    try (AlarmDb db = new AlarmDb(c)) {
      String unavailable = unavailable(c);
      Set<String> consumed = db.consumed();
      long now = System.currentTimeMillis();
      int total = 0;
      for (JSONObject a : db.definitions()) {
        String id = a.getString("id");
        long old = a.optLong("nextAt");
        // A normal foreground refresh must not cancel a legitimately in-flight event delivery.
        // Recovery after boot/time changes never starts overdue audio or replays a backlog.
        if (!recovery
            && old > 0
            && ClockRules.onTime(old, now)
            && a.getBoolean("enabled")
            && unavailable.isEmpty()
            && !consumed.contains(a.optString("occ"))
            && a.has("eventLink")
            && "ready".equals(a.getJSONObject("eventLink").optString("state"))
            && old
                == a.getJSONObject("eventLink").getLong("startAt")
                    - a.getJSONObject("eventLink").getLong("offsetMinutes") * 60000) {
          total++;
          continue;
        }
        cancel(c, id);
        boolean confirmedFutureReschedule =
            a.has("eventLink")
                && "ready".equals(a.getJSONObject("eventLink").optString("state"))
                && a.getJSONObject("eventLink").getLong("startAt")
                        - a.getJSONObject("eventLink").getLong("offsetMinutes") * 60000
                    > now;
        if (old > 0 && old <= now && !confirmedFutureReschedule) {
          db.mark(a.optString("occ"), "missed during recovery");
          consumed.add(a.optString("occ"));
        }
        if (!a.getBoolean("enabled") || !unavailable.isEmpty()) {
          db.scheduled(id, 0, "");
          continue;
        }
        JSONArray rows = a.getJSONArray("days");
        Set<Integer> days = new HashSet<>();
        for (int i = 0; i < rows.length(); i++) days.add(rows.getInt(i));
        ClockRules.Occurrence next =
            a.has("eventLink")
                ? EventAlarmRules.next(a, now, consumed)
                : ClockRules.next(
                    id,
                    a.getString("date"),
                    a.getString("time"),
                    a.getString("mode").equals("repeat"),
                    days,
                    now,
                    ZoneId.systemDefault(),
                    consumed);
        if (next == null) {
          db.scheduled(id, 0, "");
          continue;
        }
        PendingIntent show =
            PendingIntent.getActivity(
                c,
                0,
                new Intent(c, AlarmActivity.class),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        // Store intended identity first; the receiver rejects stale/disabled duplicates.
        db.scheduled(id, next.at(), next.key());
        try {
          c.getSystemService(AlarmManager.class)
              .setAlarmClock(
                  new AlarmManager.AlarmClockInfo(next.at(), show),
                  delivery(c, id, next.key(), "FIRE"));
          total++;
        } catch (SecurityException denied) {
          db.scheduled(id, 0, "");
          unavailable = "Exact alarm access was revoked while scheduling.";
        }
      }
      db.status(
          unavailable.isEmpty()
              ? total
                  + " alarm(s) scheduled locally. Check device DND/battery settings;"
                  + " force-stop/power-off cannot ring."
              : "Not armed: " + unavailable);
    } catch (Exception e) {
      try (AlarmDb db = new AlarmDb(c)) {
        db.status("Scheduling failed: " + e.getMessage());
      }
    }
  }
}
