# Plan and actual timeline

The plan and recorded-activity rows share the application's wall-clock axis and time zone. Recorded activity comes from canonical `time_entry` blocks; ongoing activity uses the existing work-session accessor and unattended-work cutoff. No data is written by these bars.

On a timezone offset transition, intervals with real instants split at the transition. For example, New York 2026-11-01 01:50 EDT through 01:10 EST is twenty real minutes: ten minutes at 01:50–02:00 on the pre-change portion of the clock axis and ten minutes at 01:00–01:10 after the change. The first portion's endpoint is exclusive. Overlapping clock portions use separate lanes compressed within the same total track height as the plan (18px desktop, 14px narrow mobile). No recording is removed; keyboard focus expands the selected portion within that fixed track for inspection. The tooltip gives the actual interval endpoints with zone abbreviations, total elapsed session time, and the duration of the displayed portion. A spring-forward session from 01:50 EST to 03:10 EDT leaves the skipped 02:00–03:00 range empty. Midnight clips to the selected application's date, including 23- and 25-hour days.

Clock-only entries on offset-transition dates do not identify a unique instant, so they are summarized as unpositioned minutes. Estimated, inferred, legacy and unknown evidence never acquires a fabricated position.

Day review is independent of Actual details and never changes or saves its preference. Its shared-header button navigates Working Queue to the itinerary before opening review; browser Back returns to the queue. Review open/closed state is ephemeral. Legacy Actual URLs/preferences remain supported, with a visible **Hide actual details** action to turn off and save that choice. Closing review does not toggle those legacy details.

Minute refresh restores focus to the same plan/task or actual/portion key. If that segment has disappeared, focus moves to the Day review control.
