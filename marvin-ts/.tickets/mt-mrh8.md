---
id: mt-mrh8
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
# Location, places, weather, maps tools

Implement src/tools/location.ts (get_my_location via GeoClue/CoreLocation with IP fallback), src/tools/places.ts (places_text_search, places_nearby_search via Google Places with OSM fallback, setup_google_auth), src/tools/weather.ts (weather_forecast), src/tools/maps.ts (osm_search via Nominatim, overpass_query), src/tools/travel.ts (travel tools).

