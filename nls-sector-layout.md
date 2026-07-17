# NLS – Nordschleife 5-Sector Layout

The full NLS configuration (Nürburgring **24h-layout**: Nordschleife + part of the GP circuit / Sprintstrecke) is officially **24.358 km** long — Nordschleife ≈ 20.832 km + the GP section ≈ 3.5 km.

The timing splits each lap into **5 sectors**. The lengths below are **estimated** from the fastest lap-time breakdown (car #28, sum of best sectors = 7:58.675) scaled to 24.358 km.

> **Note:** This is a time-based approximation. Because the average speed differs per sector (slow GP corners vs. the very fast Döttinger Höhe), the real distances can differ by a few hundred metres.

## Sector table

| Sector | Best time (ref.) | Share | Estimated length | Notes |
|--------|------------------|-------|------------------|-------|
| S1 | ~1:05.8 | 13.7 % | ≈ 3.3 km | GP section + start of Nordschleife (incl. pit exit) |
| S2 | ~1:04.0 | 13.4 % | ≈ 3.3 km | |
| S3 | ~1:57.2 | 24.5 % | ≈ 6.0 km | |
| S4 | ~3:03.9 | 38.4 % | ≈ 9.4 km | Longest Nordschleife block (incl. Döttinger Höhe) |
| S5 | ~0:48.2 | 10.1 % | ≈ 2.4 km | Short final sector on the GP circuit to start/finish |
| **Total** | **7:58.7** | **100 %** | **24.358 km** | |

## Sector boundaries (derived from the timing data)

- **Start/finish + pit lane are on the GP circuit, around the S5 → S1 boundary.**
  - **The pit entry sits at the END of S5**, just before the start/finish line — *not* at
    the S4/S5 boundary. A car peeling into the lane drives the whole of S5 but never
    crosses the S5 beacon on the line, so no S5 split is published for it.
  - On *in-laps* (`INPIT = J`), **S5 is empty** and a `PITIN_TIME` is present. This means
    the split is *missing*, **not** that the sector was skipped — the measured hole
    between S4 and the out-lap's S1 has a median of **65.5s** against a **54.5s** median
    green S5, i.e. one S5 of driving plus ~11s of pit-entry decel. Were the entry at the
    S4/S5 boundary the hole would have to swallow the whole stop and run to minutes.
  - On *out-laps* (`INPIT = A`), **S1 is huge** — median **234.8s** vs a normal **74.6s**.
    The pit box, the exit and the Code-60 / out zone are all inside S1, so **the stop
    time lives in S1**, not in the hole.
- S4 is by far the longest sector in time (the long, fast Nordschleife stretch).

> Measured over the 273 stops in the 2026-06-20 DB (all 285 pit in-laps lack an S5).
> `index.html` reconstructs the missing in-lap S5 (`withPitS5`) for map positioning
> only; gap/boundary maths still runs off the real splits in `DB.legs`.
