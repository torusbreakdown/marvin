---
id: mt-lu10
status: closed
deps: [mt-it7x]
links: []
created: 2026-02-18T00:27:25Z
type: task
priority: 2
assignee: kmd
parent: mt-vn5c
tags: [backend, profiles]
---
# Profile manager and YAML preferences

Implement src/profiles/manager.ts: loadOrCreateProfile(name?), switchProfile(name), listProfiles(). Profiles in ~/.config/local-finder/profiles/<name>/. Track last active in ~/.config/local-finder/last_profile. Implement src/profiles/prefs.ts: loadPrefs(profileDir) → UserPreferences from prefs.yaml, updatePrefs(profileDir, updates), loadSavedPlaces(profileDir) → SavedPlace[].

