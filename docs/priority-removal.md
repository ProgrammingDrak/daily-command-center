# Retired task priority

Task priority controls, labels, priority groups and priority-based ordering are retired. Existing priority properties and the legacy Priority stage are retained as compatibility data, without affecting task ordering or point calculation. No migration deletes or rewrites task records. Existing tasks, notes, recurrence, Waiting state and manual order remain intact.

Old task-library priority filters, columns, groups and sorts are ignored when loading saved views. Former Priority-stage tasks remain available in the task library and backlog. Unscheduled suggestions and action items remain available without priority ranking. Review tomorrow orders by age, then duration.

External callers may continue sending the legacy priority property for compatibility. Explicit urgency and importance fields, responsibility scores, budget tank ordering and source-resolution precedence are separate mechanisms and remain supported. Already earned points are unchanged.
