package com.drake.dccalarm;

import java.time.*;
import java.util.Set;

/** Device-local wall-time policy. Independent of Android, clock and storage. */
public final class ClockRules {
  public record Occurrence(long at, String key) {}

  public static Occurrence next(
      String id,
      String date,
      String time,
      boolean repeat,
      Set<Integer> days,
      long now,
      ZoneId zone,
      Set<String> consumed) {
    LocalDate today = Instant.ofEpochMilli(now).atZone(zone).toLocalDate();
    LocalTime t = LocalTime.parse(time);
    for (int i = 0; i < (repeat ? 8 : 1); i++) {
      LocalDate d = repeat ? today.plusDays(i) : LocalDate.parse(date);
      int weekday = d.getDayOfWeek().getValue() % 7;
      if (repeat && !days.contains(weekday)) continue;
      // atZone moves gaps forward and chooses the earlier offset in folds.
      long at = d.atTime(t).atZone(zone).toInstant().toEpochMilli();
      String key = id + "/" + d;
      if (at > now && !consumed.contains(key)) return new Occurrence(at, key);
    }
    return null;
  }

  public static boolean onTime(long due, long now) {
    return due <= now && now - due <= 60000;
  }
}
