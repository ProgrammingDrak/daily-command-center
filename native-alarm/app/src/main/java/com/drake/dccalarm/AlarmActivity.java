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
    String proposed = getIntent().getStringExtra("reviewDefinitions");
    getIntent().removeExtra("reviewDefinitions");
    if (proposed != null && proposed.length() <= 65536) {
      try {
        confirmDefinitions(new JSONArray(proposed));
      } catch (Exception e) {
        feedback.setText(getString(R.string.ui_invalid_definitions_2d98b));
      }
    }
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
      scroll.setOnApplyWindowInsetsListener(
          (view, insets) -> {
            android.graphics.Insets safe =
                insets.getInsets(
                    WindowInsets.Type.systemBars()
                        | WindowInsets.Type.displayCutout()
                        | WindowInsets.Type.ime());
            view.setPadding(safe.left, safe.top, safe.right, safe.bottom);
            return WindowInsets.CONSUMED;
          });
      setContentView(scroll);
      scroll.requestApplyInsets();
      text("DCC · device alarms", 26);
      feedback = text(db.status(), 16);
      feedback.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
      if (r != null) {
        challenge(r);
        return;
      }
      text(
          "Part of this DCC Android app. Alarms belong to this phone, shared across DCC accounts;"
              + " logging out does not disable them. Scheduling requires exact,"
              + " notification and lock-screen access. Force-stop or power-off prevents delivery."
              + " No cloud account or sync.",
          16);
      button("Add phone alarm", () -> editAlarm(null));
      button("Back to DCC dashboard", this::finish);
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
        button("Edit " + a.getString("label"), () -> editAlarm(a));
        button("Remove " + a.getString("label"), () -> removeAlarm(id));
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
          "Native snooze is disabled in this first build. Chime/pulse browser tones use"
              + " the Android system alarm ringtone here. Check system alarm volume and DND. Before"
              + " relying on delivery, validate your phone's locked/Doze/reboot behavior.",
          16);
    } catch (Exception e) {
      shown = "";
      if (feedback != null)
        feedback.setText(getString(R.string.local_state_failed, e.getMessage()));
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
    answer.setHint(getString(R.string.ui_whole_number_answer_38003));
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
            feedback.setText(getString(R.string.answer_not_saved, e.getMessage()));
          }
        };
    answer.setOnEditorActionListener(
        (v, action, event) -> {
          if (action == EditorInfo.IME_ACTION_DONE
              || (event != null
                  && event.getKeyCode() == KeyEvent.KEYCODE_ENTER
                  && event.getAction() == KeyEvent.ACTION_DOWN)) {
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

  private void confirmDefinitions(JSONArray definitions) {
    if (definitions.length() > 20) {
      feedback.setText(getString(R.string.ui_maximum_20_phone_alarms_4c6d7));
      return;
    }
    new AlertDialog.Builder(this)
        .setTitle(getString(R.string.ui_save_this_phone_s_alarm_definitions_b3e9c))
        .setMessage(
            "Replaces this phone's definitions with "
                + definitions.length()
                + " entries. Enabled alarms are scheduled only if you have approved capabilities."
                + " Existing browser definitions are not changed. No permissions are granted."
                + " Pending quizzes prevent replacement.")
        .setNegativeButton("Cancel", null)
        .setPositiveButton(
            "Save and schedule",
            (dialog, which) -> {
              try (AlarmDb db = new AlarmDb(this)) {
                java.util.List<JSONObject> old = db.definitions();
                db.importDefinitions(definitions);
                for (JSONObject a : old) AlarmScheduler.cancel(this, a.getString("id"));
                AlarmScheduler.reconcile(this);
                render(true);
              } catch (Exception e) {
                feedback.setText(getString(R.string.save_failed, e.getMessage()));
              }
            })
        .show();
  }

  private void removeAlarm(String id) {
    try (AlarmDb db = new AlarmDb(this)) {
      JSONArray entries = new JSONArray();
      for (JSONObject a : db.definitions()) if (!id.equals(a.getString("id"))) entries.put(a);
      confirmDefinitions(entries);
    } catch (Exception e) {
      feedback.setText(e.getMessage());
    }
  }

  private Spinner select(LinearLayout form, String label, String[] options, String current) {
    TextView title = new TextView(this);
    title.setText(label);
    form.addView(title);
    Spinner spinner = new Spinner(this);
    spinner.setContentDescription(label);
    spinner.setAdapter(
        new ArrayAdapter<String>(this, android.R.layout.simple_spinner_dropdown_item, options));
    spinner.setMinimumHeight(dp(48));
    form.addView(spinner);
    for (int i = 0; i < options.length; i++)
      if (options[i].equals(current)) spinner.setSelection(i);
    return spinner;
  }

  private void editAlarm(JSONObject existing) {
    try {
      JSONObject a =
          existing == null
              ? new JSONObject()
                  .put("id", java.util.UUID.randomUUID().toString())
                  .put("label", "Morning alarm")
                  .put("time", "07:00")
                  .put("date", java.time.LocalDate.now().toString())
                  .put("mode", "repeat")
                  .put("days", new JSONArray("[1,2,3,4,5]"))
                  .put("challenge", "math")
                  .put("difficulty", "easy")
                  .put("count", 3)
                  .put("enabled", false)
                  .put("volume", 0.15)
                  .put("snoozes", 0)
                  .put("tone", "system")
              : new JSONObject(existing.toString());
      LinearLayout form = new LinearLayout(this);
      form.setOrientation(LinearLayout.VERTICAL);
      form.setPadding(dp(16), dp(8), dp(16), dp(8));
      EditText name = new EditText(this);
      name.setHint(getString(R.string.ui_alarm_name_c337b));
      name.setContentDescription(getString(R.string.ui_alarm_name_c337b));
      name.setSingleLine(true);
      name.setText(a.getString("label"));
      name.setFilters(
          new android.text.InputFilter[] {new android.text.InputFilter.LengthFilter(80)});
      form.addView(name);
      Button time = new Button(this);
      time.setText(getString(R.string.time_label, a.getString("time")));
      form.addView(time);
      time.setOnClickListener(
          v -> {
            String[] parts = a.optString("time").split(":");
            new TimePickerDialog(
                    this,
                    (view, h, m) -> {
                      try {
                        a.put("time", String.format(java.util.Locale.ROOT, "%02d:%02d", h, m));
                        time.setText(getString(R.string.time_label, a.optString("time")));
                      } catch (Exception ignored) {
                      }
                    },
                    Integer.parseInt(parts[0]),
                    Integer.parseInt(parts[1]),
                    android.text.format.DateFormat.is24HourFormat(this))
                .show();
          });
      Spinner mode = select(form, "Schedule", new String[] {"repeat", "once"}, a.optString("mode"));
      Button date = new Button(this);
      date.setText(getString(R.string.date_label, a.optString("date")));
      form.addView(date);
      date.setOnClickListener(
          v -> {
            java.time.LocalDate d = java.time.LocalDate.parse(a.optString("date"));
            new DatePickerDialog(
                    this,
                    (view, y, m, day) -> {
                      try {
                        a.put("date", java.time.LocalDate.of(y, m + 1, day).toString());
                        date.setText(getString(R.string.date_label, a.optString("date")));
                      } catch (Exception ignored) {
                      }
                    },
                    d.getYear(),
                    d.getMonthValue() - 1,
                    d.getDayOfMonth())
                .show();
          });
      TextView dayLabel = new TextView(this);
      dayLabel.setText(getString(R.string.ui_repeat_days_used_for_repeat_schedule_504c3));
      form.addView(dayLabel);
      CheckBox[] days = new CheckBox[7];
      String[] names = {
        "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"
      };
      java.util.Set<Integer> selected = new java.util.HashSet<>();
      JSONArray oldDays = a.getJSONArray("days");
      for (int i = 0; i < oldDays.length(); i++) selected.add(oldDays.getInt(i));
      for (int i = 0; i < 7; i++) {
        days[i] = new CheckBox(this);
        days[i].setText(names[i]);
        days[i].setChecked(selected.contains(i));
        days[i].setMinHeight(dp(48));
        form.addView(days[i]);
      }
      Spinner type =
          select(form, "Challenge", new String[] {"math", "quiz"}, a.optString("challenge"));
      Spinner difficulty =
          select(
              form,
              "Difficulty",
              new String[] {"easy", "medium", "hard"},
              a.optString("difficulty"));
      Spinner count =
          select(
              form,
              "Correct answers required",
              new String[] {"1", "2", "3", "4", "5", "6", "7", "8", "9", "10"},
              String.valueOf(a.optInt("count")));
      TextView volumeLabel = new TextView(this);
      volumeLabel.setText(getString(R.string.ui_alarm_volume_0_to_50_of_system_alarm_level_fbdd2));
      form.addView(volumeLabel);
      SeekBar volume = new SeekBar(this);
      volume.setMax(50);
      volume.setProgress((int) (100 * a.optDouble("volume", 0.15)));
      volume.setContentDescription(getString(R.string.ui_alarm_volume_percentage_maximum_50_61d5b));
      form.addView(volume);
      CheckBox enabled = new CheckBox(this);
      enabled.setText(getString(R.string.ui_enable_this_phone_alarm_d4925));
      enabled.setChecked(a.optBoolean("enabled"));
      enabled.setMinHeight(dp(48));
      form.addView(enabled);
      ScrollView scroll = new ScrollView(this);
      scroll.addView(form);
      AlertDialog dialog =
          new AlertDialog.Builder(this)
              .setTitle(existing == null ? "Add phone alarm" : "Edit phone alarm")
              .setView(scroll)
              .setNegativeButton("Cancel", null)
              .setPositiveButton("Review save", null)
              .create();
      dialog.setOnShowListener(
          d ->
              dialog
                  .getButton(AlertDialog.BUTTON_POSITIVE)
                  .setOnClickListener(
                      v -> {
                        try {
                          a.put("label", name.getText().toString().trim())
                              .put("mode", mode.getSelectedItem())
                              .put("challenge", type.getSelectedItem())
                              .put("difficulty", difficulty.getSelectedItem())
                              .put("count", Integer.parseInt(count.getSelectedItem().toString()))
                              .put("enabled", enabled.isChecked())
                              .put("volume", volume.getProgress() / 100.0)
                              .put("snoozes", 0);
                          JSONArray newDays = new JSONArray();
                          for (int i = 0; i < 7; i++) if (days[i].isChecked()) newDays.put(i);
                          a.put("days", newDays);
                          AlarmDb.validate(a);
                          if ("once".equals(a.getString("mode"))
                              && ClockRules.next(
                                      a.getString("id"),
                                      a.getString("date"),
                                      a.getString("time"),
                                      false,
                                      java.util.Set.of(),
                                      System.currentTimeMillis(),
                                      java.time.ZoneId.systemDefault(),
                                      java.util.Set.of())
                                  == null)
                            throw new IllegalArgumentException("Choose a future date and time");
                          JSONArray all = new JSONArray();
                          try (AlarmDb db = new AlarmDb(this)) {
                            for (JSONObject old : db.definitions())
                              if (!old.getString("id").equals(a.getString("id"))) all.put(old);
                          }
                          all.put(a);
                          dialog.dismiss();
                          confirmDefinitions(all);
                        } catch (Exception e) {
                          name.setError(e.getMessage());
                          name.requestFocus();
                        }
                      }));
      dialog.show();
    } catch (Exception e) {
      feedback.setText(getString(R.string.editor_unavailable, e.getMessage()));
    }
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
      confirmDefinitions(definitions);
    } catch (Exception e) {
      feedback.setText(getString(R.string.import_failed, e.getMessage()));
    }
  }
}
