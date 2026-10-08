package com.drake.dccalarm;

import android.content.*;
import android.database.Cursor;
import android.database.sqlite.*;
import java.util.*;
import org.json.*;

public final class AlarmDb extends SQLiteOpenHelper {
  public AlarmDb(Context c) {
    super(c.createDeviceProtectedStorageContext(), "alarms.db", null, 1);
  }

  public void onCreate(SQLiteDatabase db) {
    db.execSQL(
        "CREATE TABLE defs(id TEXT PRIMARY KEY,payload TEXT NOT NULL,nextAt INTEGER DEFAULT 0,occ"
            + " TEXT DEFAULT '')");
    db.execSQL(
        "CREATE TABLE runs(occ TEXT PRIMARY KEY,id TEXT NOT NULL,payload TEXT NOT NULL,questions"
            + " TEXT NOT NULL,progress INTEGER DEFAULT 0,snoozed INTEGER DEFAULT 0,untilAt INTEGER"
            + " DEFAULT 0)");
    db.execSQL("CREATE TABLE ledger(occ TEXT PRIMARY KEY,reason TEXT NOT NULL)");
    db.execSQL("CREATE TABLE meta(id TEXT PRIMARY KEY,value TEXT NOT NULL)");
  }

  public void onUpgrade(SQLiteDatabase db, int old, int version) {
    throw new IllegalStateException("Unsupported database version");
  }

  static JSONObject json(String s) {
    try {
      return new JSONObject(s);
    } catch (JSONException e) {
      throw new IllegalArgumentException("Invalid JSON", e);
    }
  }

  public List<JSONObject> definitions() {
    List<JSONObject> out = new ArrayList<>();
    try (Cursor c = getReadableDatabase().rawQuery("SELECT payload,nextAt,occ FROM defs", null)) {
      while (c.moveToNext()) {
        JSONObject a = json(c.getString(0));
        try {
          a.put("nextAt", c.getLong(1));
          a.put("occ", c.getString(2));
        } catch (JSONException e) {
          throw new IllegalStateException(e);
        }
        out.add(a);
      }
    }
    return out;
  }

  public Set<String> consumed() {
    Set<String> out = new HashSet<>();
    try (Cursor c = getReadableDatabase().rawQuery("SELECT occ FROM ledger", null)) {
      while (c.moveToNext()) out.add(c.getString(0));
    }
    return out;
  }

  public void status(String text) {
    ContentValues v = new ContentValues();
    v.put("id", "status");
    v.put("value", text);
    getWritableDatabase().insertWithOnConflict("meta", null, v, SQLiteDatabase.CONFLICT_REPLACE);
  }

  public String status() {
    try (Cursor c =
        getReadableDatabase().rawQuery("SELECT value FROM meta WHERE id='status'", null)) {
      return c.moveToFirst() ? c.getString(0) : "No alarms imported. Nothing is armed.";
    }
  }

  public void importDefinitions(JSONArray rows) throws JSONException {
    if (rows.length() > 20) throw new IllegalArgumentException("Maximum 20 alarms");
    Set<String> ids = new HashSet<>();
    Set<String> links = new HashSet<>();
    for (int i = 0; i < rows.length(); i++) {
      JSONObject a = rows.getJSONObject(i);
      validate(a);
      if (a.has("eventLink")) {
        JSONObject l = a.getJSONObject("eventLink");
        String key = l.getString("workspaceId") + "/" + l.getString("blockId");
        if (!links.add(key)) throw new IllegalArgumentException("Duplicate event links");
      }
      if (!ids.add(a.getString("id"))) throw new IllegalArgumentException("Duplicate IDs");
    }
    SQLiteDatabase db = getWritableDatabase();
    db.beginTransaction();
    try {
      try (Cursor c = db.rawQuery("SELECT COUNT(*) FROM runs", null)) {
        c.moveToFirst();
        if (c.getInt(0) > 0)
          throw new IllegalStateException("Stop pending challenges before importing");
      }
      db.delete("defs", null, null);
      for (int i = 0; i < rows.length(); i++) {
        JSONObject a = rows.getJSONObject(i);
        ContentValues v = new ContentValues();
        v.put("id", a.getString("id"));
        v.put("payload", a.toString());
        db.insertOrThrow("defs", null, v);
      }
      db.setTransactionSuccessful();
    } finally {
      db.endTransaction();
    }
  }

  static void validate(JSONObject a) throws JSONException {
    if (!a.getString("id").matches("[A-Za-z0-9_-]{1,100}") || a.getString("label").length() > 80)
      throw new IllegalArgumentException("Invalid ID/name");
    if (!a.getString("date").matches("[0-9]{4}-[0-9]{2}-[0-9]{2}")
        || !a.getString("time").matches("([01][0-9]|2[0-3]):[0-5][0-9]"))
      throw new IllegalArgumentException("Invalid date/time");
    java.time.LocalDate.parse(a.getString("date"));
    java.time.LocalTime.parse(a.getString("time"));
    if (!Set.of("once", "repeat").contains(a.getString("mode"))
        || !Set.of("math", "quiz").contains(a.getString("challenge"))
        || !Set.of("easy", "medium", "hard").contains(a.getString("difficulty")))
      throw new IllegalArgumentException("Invalid configuration");
    int count = a.getInt("count");
    if (a.getDouble("count") != count || count < 1 || count > 10)
      throw new IllegalArgumentException("Use 1–10 questions");
    double volume = a.getDouble("volume");
    if (!Double.isFinite(volume) || volume < 0 || volume > 0.5)
      throw new IllegalArgumentException("Invalid volume");
    int snoozes = a.getInt("snoozes");
    if (a.getDouble("snoozes") != snoozes || snoozes < 0 || snoozes > 1)
      throw new IllegalArgumentException("Invalid snooze");
    if (a.has("eventLink")) {
      EventAlarmRules.validate(a.getJSONObject("eventLink"));
      if (!"once".equals(a.getString("mode")))
        throw new IllegalArgumentException("Event alarms use one occurrence");
    }
    a.getBoolean("enabled");
    JSONArray days = a.getJSONArray("days");
    if (a.getString("mode").equals("repeat") && days.length() == 0)
      throw new IllegalArgumentException("Choose repeat days");
    for (int i = 0; i < days.length(); i++)
      if (days.getDouble(i) != days.getInt(i) || days.getInt(i) < 0 || days.getInt(i) > 6)
        throw new IllegalArgumentException("Invalid day");
  }

  public boolean syncEvent(JSONObject link, long now) throws JSONException {
    EventAlarmRules.validate(link);
    if (link.getLong("checkedAt") > now + 60000 || link.getLong("checkedAt") < now - 60000)
      throw new IllegalArgumentException("Refresh timestamp invalid");
    SQLiteDatabase db = getWritableDatabase();
    boolean stopped = false;
    db.beginTransaction();
    try {
      for (JSONObject a : definitions()) {
        JSONObject old = a.optJSONObject("eventLink");
        if (old == null
            || !EventAlarmRules.same(old, link)
            || old.getLong("checkedAt") > link.getLong("checkedAt")) continue;
        a.put("eventLink", link);
        if (!"ready".equals(link.getString("state"))) {
          a.put("enabled", false);
          try (Cursor c =
              db.rawQuery("SELECT occ FROM runs WHERE id=?", new String[] {a.getString("id")})) {
            while (c.moveToNext()) {
              stop(c.getString(0), "event unavailable");
              stopped = true;
            }
          }
        }
        ContentValues v = new ContentValues();
        v.put("payload", a.toString());
        db.update("defs", v, "id=?", new String[] {a.getString("id")});
      }
      db.setTransactionSuccessful();
      return stopped;
    } finally {
      db.endTransaction();
    }
  }

  public void toggle(String id) throws JSONException {
    SQLiteDatabase db = getWritableDatabase();
    db.beginTransaction();
    try {
      for (JSONObject a : definitions())
        if (a.getString("id").equals(id)) {
          a.put("enabled", !a.getBoolean("enabled"));
          ContentValues v = new ContentValues();
          v.put("payload", a.toString());
          db.update("defs", v, "id=?", new String[] {id});
          if (!a.getBoolean("enabled")) {
            try (Cursor c = db.rawQuery("SELECT occ FROM runs WHERE id=?", new String[] {id})) {
              while (c.moveToNext()) stop(c.getString(0), "disabled");
            }
          }
        }
      db.setTransactionSuccessful();
    } finally {
      db.endTransaction();
    }
  }

  public void scheduled(String id, long at, String key) {
    ContentValues v = new ContentValues();
    v.put("nextAt", at);
    v.put("occ", key);
    getWritableDatabase().update("defs", v, "id=?", new String[] {id});
  }

  public void mark(String key, String reason) {
    ContentValues v = new ContentValues();
    v.put("occ", key);
    v.put("reason", reason);
    getWritableDatabase().insertWithOnConflict("ledger", null, v, SQLiteDatabase.CONFLICT_IGNORE);
  }

  public boolean receive(String id, String key, long now) throws JSONException {
    SQLiteDatabase db = getWritableDatabase();
    db.beginTransaction();
    try {
      JSONObject a = null;
      for (JSONObject row : definitions()) if (row.getString("id").equals(id)) a = row;
      if (a == null
          || !a.getBoolean("enabled")
          || !key.equals(a.optString("occ"))
          || consumed().contains(key)) return false;
      if (a.has("eventLink") && !EventAlarmRules.usable(a.getJSONObject("eventLink"), now))
        return false;
      if (now < a.getLong("nextAt")) return false;
      if (!ClockRules.onTime(a.getLong("nextAt"), now)) {
        mark(key, "missed");
        status("A late alarm was skipped");
        db.setTransactionSuccessful();
        return false;
      }
      ContentValues v = new ContentValues();
      v.put("occ", key);
      v.put("id", id);
      v.put("payload", a.toString());
      v.put("questions", questions(a).toString());
      db.insertOrThrow("runs", null, v);
      mark(key, "started");
      db.setTransactionSuccessful();
      return true;
    } finally {
      db.endTransaction();
    }
  }

  public JSONObject active() {
    return run(false);
  }

  public JSONObject run(boolean snoozed) {
    try (Cursor c =
        getReadableDatabase()
            .rawQuery(
                "SELECT occ,payload,questions,progress,snoozed,untilAt FROM runs WHERE untilAt "
                    + (snoozed ? ">0" : "=0")
                    + " ORDER BY rowid LIMIT 1",
                null)) {
      if (!c.moveToFirst()) return null;
      JSONObject r = new JSONObject();
      try {
        r.put("key", c.getString(0));
        r.put("alarm", json(c.getString(1)));
        r.put("questions", new JSONArray(c.getString(2)));
        r.put("index", c.getInt(3));
        r.put("snoozed", c.getInt(4));
        r.put("until", c.getLong(5));
      } catch (JSONException e) {
        throw new IllegalStateException(e);
      }
      return r;
    }
  }

  public boolean answer(String key, String input) throws JSONException {
    SQLiteDatabase db = getWritableDatabase();
    db.beginTransaction();
    try {
      JSONObject r = active();
      if (r == null || !r.getString("key").equals(key) || !input.trim().matches("[0-9]{1,6}"))
        return false;
      int index = r.getInt("index");
      if (!r.getJSONArray("questions")
          .getJSONObject(index)
          .getString("answer")
          .equals(String.valueOf(Integer.parseInt(input.trim())))) return false;
      index++;
      if (index == r.getJSONArray("questions").length()) stop(key, "completed");
      else {
        ContentValues v = new ContentValues();
        v.put("progress", index);
        db.update("runs", v, "occ=?", new String[] {key});
      }
      db.setTransactionSuccessful();
      return true;
    } finally {
      db.endTransaction();
    }
  }

  public void stop(String key, String reason) {
    SQLiteDatabase db = getWritableDatabase();
    db.delete("runs", "occ=?", new String[] {key});
    ContentValues v = new ContentValues();
    v.put("reason", reason);
    db.update("ledger", v, "occ=?", new String[] {key});
    status(reason);
  }

  public void stopAll() {
    SQLiteDatabase db = getWritableDatabase();
    db.beginTransaction();
    try {
      try (Cursor c = db.rawQuery("SELECT occ FROM runs", null)) {
        while (c.moveToNext()) stop(c.getString(0), "emergency stopped");
      }
      db.setTransactionSuccessful();
    } finally {
      db.endTransaction();
    }
  }

  static JSONArray questions(JSONObject a) throws JSONException {
    JSONArray out = new JSONArray();
    Random random = new Random();
    String[][]
        easy =
            {
              {"Sides of a triangle?", "3"}, {"Minutes in an hour?", "60"}, {"Days in a week?", "7"}
            },
        medium =
            {
              {"Degrees in a right angle?", "90"},
              {"Square root of 81?", "9"},
              {"Hours in two days?", "48"}
            },
        hard =
            {
              {"Next prime after 19?", "23"},
              {"Degrees in a triangle?", "180"},
              {"2 to the power of 8?", "256"}
            };
    String level = a.getString("difficulty");
    for (int i = 0; i < a.getInt("count"); i++) {
      String prompt, answer;
      if (a.getString("challenge").equals("quiz")) {
        String[] q =
            (level.equals("hard") ? hard : level.equals("medium") ? medium : easy)
                [random.nextInt(3)];
        prompt = q[0];
        answer = q[1];
      } else {
        int x = 1 + random.nextInt(level.equals("hard") ? 99 : level.equals("medium") ? 40 : 9),
            y = 1 + random.nextInt(level.equals("hard") ? 12 : level.equals("medium") ? 40 : 9);
        boolean mult = level.equals("hard");
        prompt = x + (mult ? " × " : " + ") + y + " = ?";
        answer = String.valueOf(mult ? x * y : x + y);
      }
      out.put(new JSONObject().put("prompt", prompt).put("answer", answer));
    }
    return out;
  }
}
