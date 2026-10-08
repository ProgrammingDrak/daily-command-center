package com.drake.dccalarm;

import android.content.*;

public final class AlarmReceiver extends BroadcastReceiver {
  public void onReceive(Context c, Intent intent) {
    String action = intent.getAction();
    if ("STOP".equals(action)) {
      try (AlarmDb db = new AlarmDb(c)) {
        db.stopAll();
      }
      c.stopService(new Intent(c, AlarmService.class));
      return;
    }
    if ("FIRE".equals(action)) {
      try (AlarmDb db = new AlarmDb(c)) {
        if (!AlarmScheduler.unavailable(c).isEmpty()) {
          db.status("Alarm unavailable: " + AlarmScheduler.unavailable(c));
          return;
        }
        if (db.receive(
            intent.getStringExtra("id"),
            intent.getStringExtra("key"),
            System.currentTimeMillis())) {
          try {
            c.startForegroundService(new Intent(c, AlarmService.class));
          } catch (RuntimeException e) {
            db.status("Alarm delivery failed: " + e.getMessage());
          }
        }
      } catch (Exception e) {
        try (AlarmDb db = new AlarmDb(c)) {
          db.status("Alarm receiver failed: " + e.getMessage());
        }
      }
    }
    // Boot/time changes only rebuild future scheduling; never start audio from boot.
    AlarmScheduler.reconcile(c, !"FIRE".equals(action));
  }
}
