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
| S4 | ~3:03.9 | 38.4 % | ≈ 9.4 km | Longest Nordschleife block (incl. Döttinger Höhe → pit entry) |
| S5 | ~0:48.2 | 10.1 % | ≈ 2.4 km | Short final sector on the GP circuit to start/finish |
| **Total** | **7:58.7** | **100 %** | **24.358 km** | |

## Sector boundaries (derived from the timing data)

- **Start/finish + pit lane are on the GP circuit, around the S5 → S1 boundary.**
  - On *in-laps* (`INPIT = J`), **S5 is empty** and a `PITIN_TIME` is present → pit entry sits at the end of S4 / start of S5.
  - On *out-laps* (`INPIT = A`), **S1 is huge** (3–4 min instead of ~1:06) → the pit lane + Code-60 / out zone is inside S1.
- S4 is by far the longest sector in time (the long, fast Nordschleife stretch).
