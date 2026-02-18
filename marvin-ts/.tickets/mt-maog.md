---
id: mt-maog
status: open
deps: [mt-hgrp]
links: []
created: 2026-02-18T00:26:33Z
type: task
priority: 2
assignee: kmd
parent: mt-7sbq
tags: [backend, tools]
---
# Notes, calendar, alarms, notifications tools

Implement src/tools/notes.ts (write_note to ~/Notes or .marvin/notes/ per mode, read_note, list_notes, search_notes), src/tools/calendar.ts (list_calendar_events, add_calendar_event, delete_calendar_event with macOS/Linux detection), src/tools/alarms.ts (set_alarm, list_alarms, cancel_alarm via cron), src/tools/ntfy.ts (generate_ntfy_topic, ntfy_subscribe, ntfy_publish, ntfy_list, ntfy_unsubscribe), src/tools/timers.ts.

