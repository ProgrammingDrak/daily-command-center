package com.drake.dccalarm;

import android.app.*;
import android.content.*;
import android.content.pm.ServiceInfo;
import android.media.*;
import android.os.*;
import org.json.*;

/** Only OS alarm delivery or an explicit in-app Resume starts this service. */
public final class AlarmService extends Service {
  private MediaPlayer player;
  private PowerManager.WakeLock wake;
  private AudioFocusRequest focus;
  private String sounding = "";
  private final Handler handler = new Handler(Looper.getMainLooper());
  private final Runnable safety =
      () -> {
        try (AlarmDb db = new AlarmDb(this)) {
          db.stopAll();
          db.status("Stopped after five-minute safety limit");
        }
        stopSelf();
      };

  public IBinder onBind(Intent i) {
    return null;
  }

  public int onStartCommand(Intent intent, int flags, int startId) {
    AlarmScheduler.channel(this);
    JSONObject r;
    try (AlarmDb db = new AlarmDb(this)) {
      r = db.active();
    }
    if (r == null) {
      stopSelf();
      return START_NOT_STICKY;
    }
    try {
      PendingIntent screen =
          PendingIntent.getActivity(
              this,
              0,
              new Intent(this, AlarmActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
              PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
      PendingIntent emergency =
          PendingIntent.getBroadcast(
              this,
              0,
              new Intent(this, AlarmReceiver.class).setAction("STOP"),
              PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
      Notification.Builder b =
          new Notification.Builder(this, AlarmScheduler.CHANNEL)
              .setSmallIcon(android.R.drawable.ic_lock_idle_alarm)
              .setContentTitle("DCC alarm challenge")
              .setContentText("Solve the challenge or use Emergency stop")
              .setCategory(Notification.CATEGORY_ALARM)
              .setOngoing(true)
              .setContentIntent(screen)
              .addAction(
                  new Notification.Action.Builder(null, "Emergency stop", emergency).build());
      if (Build.VERSION.SDK_INT < 34 || AlarmScheduler.notifications(this).canUseFullScreenIntent())
        b.setFullScreenIntent(screen, true);
      startForeground(100, b.build(), ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
      String key = r.getString("key");
      if (!key.equals(sounding)) {
        stopAudio();
        sounding = key;
        handler.removeCallbacks(safety);
        handler.postDelayed(safety, 300000);
        wake =
            getSystemService(PowerManager.class)
                .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "dcc:alarm");
        wake.acquire(310000);
        AudioAttributes attributes =
            new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_ALARM)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build();
        focus =
            new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
                .setAudioAttributes(attributes)
                .setOnAudioFocusChangeListener(
                    change -> {
                      if (change < 0) stopAudio();
                    })
                .build();
        if (getSystemService(AudioManager.class).requestAudioFocus(focus)
            == AudioManager.AUDIOFOCUS_REQUEST_GRANTED) {
          player = new MediaPlayer();
          player.setAudioAttributes(attributes);
          player.setDataSource(this, RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM));
          player.setLooping(true);
          float volume = (float) r.getJSONObject("alarm").getDouble("volume");
          player.setVolume(volume, volume);
          player.setOnPreparedListener(
              ready -> {
                if (player == ready) ready.start();
              });
          player.setOnErrorListener(
              (failed, what, extra) -> {
                stopAudio();
                try (AlarmDb db = new AlarmDb(this)) {
                  db.status("Ringtone failed; visual challenge remains available");
                }
                return true;
              });
          player.prepareAsync();
        } else
          try (AlarmDb db = new AlarmDb(this)) {
            db.status("Audio focus denied; visual challenge remains available");
          }
      }
    } catch (Exception e) {
      stopAudio();
      try (AlarmDb db = new AlarmDb(this)) {
        db.status("Audio unavailable; open the visual challenge. " + e.getMessage());
      }
    }
    return START_NOT_STICKY;
  }

  private void stopAudio() {
    sounding = "";
    if (player != null) {
      player.release();
      player = null;
    }
    if (focus != null) {
      getSystemService(AudioManager.class).abandonAudioFocusRequest(focus);
      focus = null;
    }
    if (wake != null && wake.isHeld()) wake.release();
    wake = null;
  }

  public void onDestroy() {
    handler.removeCallbacksAndMessages(null);
    stopAudio();
    super.onDestroy();
  }
}
