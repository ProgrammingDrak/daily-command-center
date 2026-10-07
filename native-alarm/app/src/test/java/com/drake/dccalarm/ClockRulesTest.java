package com.drake.dccalarm;

import java.time.*;
import java.util.*;

public class ClockRulesTest {
  static long at(String time) {
    return Instant.parse(time).toEpochMilli();
  }

  static void equal(Object a, Object b) {
    if (!Objects.equals(a, b)) throw new AssertionError(a + " != " + b);
  }

  public static void main(String[] args) {
    ZoneId ny = ZoneId.of("America/New_York");
    var spring =
        ClockRules.next(
            "a", "2026-03-08", "02:30", false, Set.of(), at("2026-03-08T05:00:00Z"), ny, Set.of());
    equal(spring.at(), at("2026-03-08T07:30:00Z"));
    var fold =
        ClockRules.next(
            "a", "2026-11-01", "01:30", false, Set.of(), at("2026-11-01T04:00:00Z"), ny, Set.of());
    equal(fold.at(), at("2026-11-01T05:30:00Z"));
    equal(
        ClockRules.next(
            "a", "2026-11-01", "01:30", false, Set.of(), at("2026-11-01T05:45:00Z"), ny, Set.of()),
        null);
    equal(
        ClockRules.next(
            "a",
            "2026-11-01",
            "01:30",
            false,
            Set.of(),
            at("2026-11-01T04:00:00Z"),
            ny,
            Set.of("a/2026-11-01")),
        null);
    var repeat =
        ClockRules.next(
            "a",
            "2026-10-07",
            "07:00",
            true,
            Set.of(1, 3, 5),
            at("2026-10-09T12:00:00Z"),
            ny,
            Set.of());
    equal(repeat.at(), at("2026-10-12T11:00:00Z"));
    var travel =
        ClockRules.next(
            "a",
            "2026-10-07",
            "07:00",
            false,
            Set.of(),
            at("2026-10-07T08:00:00Z"),
            ZoneId.of("America/Los_Angeles"),
            Set.of());
    equal(travel.at(), at("2026-10-07T14:00:00Z"));
    equal(ClockRules.onTime(1000, 61000), true);
    equal(ClockRules.onTime(1000, 61001), false);
    equal(ClockRules.onTime(1000, 999), false);
    System.out.println(
        "9 synthetic native clock checks passed; no Android alarms or audio executed.");
  }
}
