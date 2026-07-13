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

localStorage is no longer used for any of the above. (Persisted only in **LIVE**;
SIM stays in-memory as it's just practice replay.)

## ⏳ Planned next — full tyre board per-car (deferred, needs a tested pass)
The tyre board (`test2.html`, TYRE reel) keeps **most of its real state in
global localStorage**, not just the small `stint9_band_state` highlights. To make
tyres truly per-car, all of these must move to per-car DB storage:

- `stint9_stock_state` — **the tyre inventory** (per-band serial / km / cycles).
- `stint9_stock_removed`, `stint9_stock_adds`, `stint9_stock_new` — stock moves.
- `stint9_stint_xfers`, `stint9_stint_removed` — stint transfers/removals.
- `stint9_empty_bands` — which parking spots are empty.
- `stint9_band_state` — highlight/number cells (has a Supabase table already).

Plan: add a `car` key to each, thread the dashboard's selected car into the
iframe (postMessage `tyreCar`), load/save per-car, and clear the board on car
change. This is an intricate board (locked orientation, unique serials, heat-
cycle & flow logic) so it needs its own change + an in-browser rehearsal before
a race. **Deferred deliberately** to avoid a half-migrated, inconsistent board.

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
