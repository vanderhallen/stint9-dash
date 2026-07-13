# Multi-team sharing — current state & planned work

Scenario: two (or more) teams open the shared dashboard, each **select a
different car**, and fill in fuel / notes / tyres. This tracks what's isolated
per-car today and what still needs doing before a large-scale rollout.

## ✅ Done — per-car in the database (no localStorage)
As of 2026-07-13, these are keyed by car and stored in Supabase (single source
of truth, so a teammate on another device sees the same data):

- **Fuel entries** — `stint9_fuel_state (event_date, car)`.
- **Fuel calculator settings** (tank capacity, consumption, start, formation) —
  stored per-car under `state.set` in the same row, applied when a car is
  selected. Two teams with different tank sizes no longer clash.
- **Per-lap notes** — `stint9_fuel_notes (event_date, car, lap)`.
- **Tyre board** (TYRE reel, `test2.html`) — the WHOLE board as one JSON blob per
  car in `stint9_tyre_state (car)`: stock inventory (serials/km/cycles), stock &
  stint moves, empty bands, and board-band highlights. The dashboard sends the
  selected car to the iframe (`postMessage 'tyreCar'`); on car change the board
  saves the outgoing car, then loads + re-renders the incoming car's blob (or a
  fresh default board if that car has none). Replaces all the old localStorage
  stores (`stint9_stock_state`, `_stock_removed/_adds/_new`, `_stint_xfers/
  _removed`, `_empty_bands`, `stint9_band_state`).

localStorage is no longer used for any of the above. (Fuel/notes persist only in
**LIVE**; SIM stays in-memory. The tyre board persists per-car whenever a car is
selected.)

⚠️ **Needs an in-browser rehearsal before race use** — the tyre-board migration
is verified for syntax + DB round-trip, but the intricate render (locked
orientation, unique serials, heat-cycle/flow logic) should be exercised live:
select car A, edit stock/stint/bands, switch to car B, confirm B is separate,
switch back and confirm A persisted.

## Kept global on purpose
- `stint9_max_km` (max km per band — a tyre spec, same across cars) stays in
  localStorage as global config.
- Board layout + sub-reel index (`test2_*`) stay local (per-device UI).

Config that is genuinely global stays global: `stint9_max_km` (max km per band),
board layout, and sub-reel index.

## ⏳ Planned — team isolation / access control (before large-scale rollout)
**Right now there is NO separation between teams** — anyone with the link can see
*and edit* any car's fuel/notes (and, once migrated, tyres). That's fine for a
couple of trusted teams sharing intentionally, but not for a wider rollout.

Future feature: a lightweight "team" concept so each team only sees/edits its own
car(s) — e.g. a team key in the URL or a simple picker, plus row scoping by team.
Until then, treat the shared link as fully open and trusted.

## localStorage intentionally kept (per-browser UI, not shared data)
UI preferences remain local by design (they're per-device, not race data):
selected class/car, delay/pace thresholds, playback speed, active reel
(`stint9_prefs`), dismissed message-board items, and the tyre board's layout.
