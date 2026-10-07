package com.drake.dccalarm;

import android.Manifest;
import android.app.*;
import android.content.*;
import android.media.*;
import android.os.*;
import android.provider.Settings;
import android.view.*;
import android.view.inputmethod.EditorInfo;
import android.widget.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import org.json.*;

public final class AlarmActivity extends Activity {
  private LinearLayout body;
  private String shown = "";
  private TextView feedback;
  private Ringtone preview;
  private final Handler handler = new Handler(Looper.getMainLooper());
  private final Runnable refresh =
      new Runnable() {
        public void run() {
          render(false);
          handler.postDelayed(this, 1000);
        }
      };

  public void onCreate(Bundle state) {
    super.onCreate(state);
    AlarmScheduler.channel(this);
    setShowWhenLocked(true);
    setTurnScreenOn(true);
    render(true);
  }

  protected void onResume() {
    super.onResume();
    AlarmScheduler.reconcile(this);
    handler.post(refresh);
  }

  protected void onPause() {
    handler.removeCallbacks(refresh);
    stopPreview();
    super.onPause();
  }

  private int dp(int value) {
    return Math.round(value * getResources().getDisplayMetrics().density);
  }

  private void stopPreview() {
    if (preview != null) {
      preview.stop();
      preview = null;
    }
  }

  private TextView text(String value, int size) {
    TextView v = new TextView(this);
    v.setText(value);
    v.setTextSize(size);
    v.setPadding(0, 14, 0, 14);
    body.addView(v);
    return v;
  }

  private void button(String label, Runnable action) {
    Button b = new Button(this);
    b.setText(label);
    b.setMinHeight(dp(48));
    body.addView(b);
    b.setOnClickListener(
        v -> {
          stopPreview();
          try {
            action.run();
          } catch (Exception e) {
            if (feedback != null) feedback.setText(e.getMessage());
          }
        });
  }

  private void emergency() {
    try (AlarmDb db = new AlarmDb(this)) {
      db.stopAll();
    }
    stopService(new Intent(this, AlarmService.class));
    shown = "";
    render(true);
  }

  private void render(boolean force) {
    try (AlarmDb db = new AlarmDb(this)) {
      JSONObject r = db.active();
      String signature =
          r == null ? "home/" + db.status() : r.optString("key") + "/" + r.optInt("index");
      if (!force && signature.equals(shown)) return;
      shown = signature;
      ScrollView scroll = new ScrollView(this);
      body = new LinearLayout(this);
      body.setOrientation(LinearLayout.VERTICAL);
      body.setPadding(dp(24), dp(48), dp(24), dp(32));
      scroll.addView(body);
      setContentView(scroll);
      text("DCC native alarm", 26);
      feedback = text(db.status(), 16);
      feedback.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
      if (r != null) {
        challenge(r);
        return;
      }
      text(
          "Local Android companion. Import DCC definitions explicitly. Scheduling requires exact,"
              + " notification and lock-screen access. Force-stop or power-off prevents delivery."
              + " No cloud account or sync.",
          16);
      for (JSONObject a : db.definitions()) {
        String id = a.getString("id");
        text(
            a.getString("label")
                + " · "
                + a.getString("time")
                + " · "
                + (a.getBoolean("enabled") ? "enabled" : "disabled")
                + "\nNext: "
                + (a.optLong("nextAt") > 0
                    ? java.time.Instant.ofEpochMilli(a.optLong("nextAt"))
                        .atZone(java.time.ZoneId.systemDefault())
                        .toString()
                    : "not scheduled"),
            17);
        button(
            a.getBoolean("enabled")
                ? "Disable " + a.getString("label")
                : "Enable " + a.getString("label"),
            () -> {
              try (AlarmDb change = new AlarmDb(this)) {
                change.toggle(id);
              } catch (Exception e) {
                throw new IllegalStateException(e);
              }
              AlarmScheduler.reconcile(this);
              render(true);
            });
      }
      button(
          "Import alarm JSON",
          () -> {
            Intent i =
                new Intent(Intent.ACTION_OPEN_DOCUMENT)
                    .setType("application/json")
                    .addCategory(Intent.CATEGORY_OPENABLE);
            startActivityForResult(i, 40);
          });
      button(
          "Allow exact alarms (opens settings)",
          () -> {
            startActivity(
                new Intent(
                    Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM,
                    android.net.Uri.parse("package:" + getPackageName())));
          });
      button(
          "Allow notifications",
          () -> {
            if (Build.VERSION.SDK_INT >= 33)
              requestPermissions(new String[] {Manifest.permission.POST_NOTIFICATIONS}, 41);
            else
              startActivity(
                  new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                      .putExtra(Settings.EXTRA_APP_PACKAGE, getPackageName()));
          });
      button(
          "Allow lock-screen alarms (opens settings)",
          () -> {
            if (Build.VERSION.SDK_INT >= 34)
              startActivity(
                  new Intent(
                      Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT,
                      android.net.Uri.parse("package:" + getPackageName())));
          });
      button(
          "Preview system alarm ringtone (4 seconds)",
          () -> {
            preview =
                RingtoneManager.getRingtone(
                    this, RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM));
            if (preview == null) throw new IllegalStateException("Ringtone unavailable");
            preview.setAudioAttributes(
                new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM).build());
            preview.setVolume(0.15f);
            preview.play();
            handler.postDelayed(this::stopPreview, 4000);
          });
      button("Stop preview sound", this::stopPreview);
      text(
          "Native snooze is disabled in this first companion build. Chime/pulse browser tones use"
              + " the Android system alarm ringtone here. Check system alarm volume and DND. Before"
              + " relying on delivery, validate your phone's locked/Doze/reboot behavior.",
          16);
    } catch (Exception e) {
      shown = "";
      if (feedback != null) feedback.setText("Local state failed: " + e.getMessage());
    }
  }

  private void challenge(JSONObject r) throws JSONException {
    String key = r.getString("key");
    JSONObject a = r.getJSONObject("alarm");
    JSONArray questions = r.getJSONArray("questions");
    int index = r.getInt("index");
    text(a.getString("label"), 24);
    text(index + " of " + questions.length() + " correct answers", 18);
    TextView question = text(questions.getJSONObject(index).getString("prompt"), 26);
    EditText answer = new EditText(this);
    answer.setInputType(android.text.InputType.TYPE_CLASS_NUMBER);
    answer.setHint("Whole-number answer");
    answer.setContentDescription("Answer to " + question.getText());
    answer.setImeOptions(EditorInfo.IME_ACTION_DONE);
    body.addView(answer);
    Runnable submit =
        () -> {
          try (AlarmDb db = new AlarmDb(this)) {
            if (db.answer(key, answer.getText().toString())) {
              JSONObject next = db.active();
              if (next == null || !key.equals(next.optString("key"))) {
                stopService(new Intent(this, AlarmService.class));
                if (next != null) startForegroundService(new Intent(this, AlarmService.class));
              }
              render(true);
            } else {
              answer.setError("Incorrect whole number; try again");
              answer.selectAll();
            }
          } catch (Exception e) {
            feedback.setText("Answer was not saved: " + e.getMessage());
          }
        };
    answer.setOnEditorActionListener(
        (v, action, event) -> {
          if (action == EditorInfo.IME_ACTION_DONE) {
            submit.run();
            return true;
          }
          return false;
        });
    button("Check answer", submit);
    button(
        "Resume alarm sound", () -> startForegroundService(new Intent(this, AlarmService.class)));
    button(
        "Silence sound; keep challenge", () -> stopService(new Intent(this, AlarmService.class)));
    button("Emergency stop — skip all pending quizzes", this::emergency);
    text(
        "Back/Home may leave the sound running. Emergency stop and the notification stop action are"
            + " always available. Sound is limited to five minutes.",
        16);
  }

  protected void onActivityResult(int request, int result, Intent data) {
    super.onActivityResult(request, result, data);
    if (request != 40 || result != RESULT_OK || data == null) return;
    try (InputStream input = getContentResolver().openInputStream(data.getData());
        ByteArrayOutputStream out = new ByteArrayOutputStream()) {
      if (input == null) throw new IOException("File unavailable");
      byte[] bytes = new byte[4096];
      int n;
      while ((n = input.read(bytes)) > 0) {
        if (out.size() + n > 65536) throw new IOException("Use a file smaller than 64 KB");
        out.write(bytes, 0, n);
      }
      JSONObject imported = new JSONObject(out.toString(StandardCharsets.UTF_8.name()));
      if (imported.getInt("version") != 1)
        throw new IllegalArgumentException("Unsupported import version");
      JSONArray definitions = imported.getJSONArray("alarms");
      new AlertDialog.Builder(this)
          .setTitle("Replace this phone's alarm definitions?")
          .setMessage(
              "Imports "
                  + definitions.length()
                  + " definitions. Enabled definitions schedule exact phone alarms only when"
                  + " capabilities are approved. Consumed occurrence history is preserved. No"
                  + " permissions are granted by importing.")
          .setNegativeButton("Cancel", null)
          .setPositiveButton(
              "Import and schedule",
              (dialog, which) -> {
                try (AlarmDb db = new AlarmDb(this)) {
                  java.util.List<JSONObject> oldDefinitions = db.definitions();
                  db.importDefinitions(definitions);
                  for (JSONObject old : oldDefinitions)
                    AlarmScheduler.cancel(this, old.getString("id"));
                  AlarmScheduler.reconcile(this);
                  render(true);
                } catch (Exception e) {
                  feedback.setText("Import failed; nothing new was armed: " + e.getMessage());
                }
              })
          .show();
    } catch (Exception e) {
      feedback.setText("Import failed: " + e.getMessage());
    }
  }
}
