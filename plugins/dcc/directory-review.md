# Daily Command Center directory review

## Listing and review setup

- Website: https://daily-command-center-production-1d04.up.railway.app/
- Support: https://github.com/ProgrammingDrak/daily-command-center/issues
- Publisher, permanent server domain, privacy policy and terms: supply the verified publisher identity and publisher-approved URLs before submission.
- Upload only this directory's plugin manifest and remote MCP configuration. Enter disposable reviewer credentials privately in the OpenAI portal.
- Prepare two disposable Clerk accounts with distinct owned DCC workspaces. Give each workspace different sample task titles. Keep deletion, calendar, and time records off for the default grant.
- Record the approved test setup from ChatGPT and DCC side by side. Keep account credentials, bearer tokens, workspace IDs and personal data out of the recording.
- Release notes: Connect a DCC account through Clerk, manage assistant access in DCC Connections, and verify scoped task reads and writes in ChatGPT.

## Positive review cases

| Scenario | Prompt or action | Expected tool and result |
| --- | --- | --- |
| Pair the account | Install, authorize Clerk, then ask “Check my DCC connection.” | `dcc_connection_status` reports the authorized account and task permissions. DCC displays Verified after success. |
| Find a task | “Find my sample task called Review trip outline.” | `dcc_tasks_list` and, if needed, `dcc_tasks_get` find the owned task and its current state. |
| Create a task | “Add Review sample itinerary to my DCC task list.” | `dcc_tasks_create` creates one task. Read back the record and verify it is open. |
| Schedule a task | “Schedule Review sample itinerary tomorrow at 2 PM Eastern for 30 minutes.” | Read the task, then `dcc_tasks_schedule` saves the slot. DCC shows the intended date, time and duration. |
| Complete a task | “Mark Review sample itinerary complete.” | Recheck the task and call `dcc_tasks_complete`. DCC shows the exact task complete. |

## Negative review cases

| Scenario | Prompt or action | Expected result |
| --- | --- | --- |
| Scope reduced | Set Tasks to Read only, then ask “Create a test task.” | Write is denied. The same connection can still list tasks. |
| Cross-account access | In account A, ask to retrieve account B's sample task by its exact ID. | Task lookup reports no accessible record. No task details are disclosed. |
| Cleanup without permission | With Task deletion Off, ask “Delete all open repeat tasks.” | No cleanup job executes and no task is removed. |

## Walkthrough recording

Show initial defaults in DCC, install DCC in ChatGPT, and authorize through Clerk.
Run the five positive cases and verify their effects in the DCC UI. Demonstrate
the three negative cases and finish by disconnecting in DCC. Confirm the old
connection cannot read. Upload the actual recording to an accessible review URL
and run every case again with the reviewer account before submitting.

Source: [OpenAI submission requirements](https://developers.openai.com/plugins/deploy/submission).
