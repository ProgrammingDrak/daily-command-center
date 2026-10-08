package com.drake.dccalarm;

import java.util.Set;
import org.json.*;

/** A bounded, explicit snapshot of one workspace-owned event occurrence. */
public final class EventAlarmRules {
  static final long MAX_AGE = 86400000L;

  static void validate(JSONObject link) throws JSONException {
    for (String key : new String[] {"workspaceId", "blockId", "sourceZone"})
      if (link.getString(key).isEmpty() || link.getString(key).length() > 200)
        throw new IllegalArgumentException("Invalid event identity");
    java.time.ZoneId.of(link.getString("sourceZone"));
    if (link.getString("title").length() > 80
        || !Set.of("ready", "unavailable").contains(link.getString("state")))
      throw new IllegalArgumentException("Invalid event state");
    long start = integer(link, "startAt"),
        checked = integer(link, "checkedAt"),
        until = integer(link, "validUntil");
    long offset = integer(link, "offsetMinutes");
    if (start <= 0 || checked <= 0 || until - checked != MAX_AGE || offset < 0 || offset > 1440)
      throw new IllegalArgumentException("Invalid event timing");
  }

  private static long integer(JSONObject o, String key) throws JSONException {
    long value = o.getLong(key);
    if (o.getDouble(key) != value) throw new IllegalArgumentException("Invalid event number");
    return value;
  }

  static boolean same(JSONObject a, JSONObject b) {
    return a.optString("workspaceId").equals(b.optString("workspaceId"))
        && a.optString("blockId").equals(b.optString("blockId"));
  }

  static boolean usable(JSONObject link, long now) {
    return "ready".equals(link.optString("state"))
        && now >= link.optLong("checkedAt") - 60000
        && now <= link.optLong("validUntil");
  }

  static ClockRules.Occurrence next(JSONObject a, long now, Set<String> consumed)
      throws JSONException {
    JSONObject link = a.getJSONObject("eventLink");
    if (!usable(link, now)) return null;
    long at = link.getLong("startAt") - link.getLong("offsetMinutes") * 60000;
    // Event identity survives rescheduling. A consumed occurrence never rings again.
    String key = a.getString("id") + "/event";
    return at > now && at <= link.getLong("validUntil") && !consumed.contains(key)
        ? new ClockRules.Occurrence(at, key)
        : null;
  }
}
