# STINT9 dash — data source

## Live / official source: teilnehmer.vln.de

The official VLN/NLS timekeeping publishes per-event **sector-times CSV** files at:

```
https://teilnehmer.vln.de/download.php?file=onb/<YYYY-MM-DD>/NÜRBURGRING_LANGSTRECKEN-SERIE$RENNEN$RENNEN_SEKTORZEITEN.CSV
```

- The `<YYYY-MM-DD>` path segment is the **event date**.
- The `Ü` and the `$` characters must be URL-encoded when fetching non-interactively
  (`%C3%9C` for Ü in a UTF-8 URL; `\$` / `%24` for the `$`).
- Landing page (to find the newest event / browse files): <https://teilnehmer.vln.de>

### Most recent file used (as of 2026-07-04)

- **Event:** 2026-06-20 · 1. ADAC Eifel-Trophy (same event as the quali PDF that
  drives the starting grid → race + grid are now from one consistent dataset).
- **URL:** `https://teilnehmer.vln.de/download.php?file=onb/2026-06-20/NÜRBURGRING_LANGSTRECKEN-SERIE$RENNEN$RENNEN_SEKTORZEITEN.CSV`
- **Saved locally:** `source/vln-2026-06-20-sektorzeiten.CSV` (source/ is gitignored).
- 2222 data rows · **109 cars** · **19 classes**.

### File format

- **Delimiter:** `;`
- **Encoding:** ISO-8859-1 / cp1252 (despite the HTTP `charset=UTF-8` header — German
  umlauts like `Türkei` come through as latin1, so parse as **cp1252**).
- **9-sector schema** (`SEKTOR1..9_ZEIT`) but only **sectors 1–5 are populated**
  for NLS — matches the existing 5-sector layout in `nls-sector-layout.md`.
- Much richer than the old `source/nls sector.CSV` (which was CUP5-only). Key columns:
  - `STNR` (car #), `KLASSEKURZ` / `KLASSE` / `UNTERKLASSE` (class), `FAHRZEUG` (car model),
    `KUERZEL` (team short), `BEWERBER` / `TEAM`.
  - `RUNDE_NR` (lap), `TAGESZEIT` (time of day), `RUNDENZEIT` + `RUNDENZEIT_IN_SEKUNDEN`,
    `DIESCHNELLSTE` (J = fastest lap flag), `RANG` (live rank).
  - `SEKTOR1..5_ZEIT`, `SEKTOR1..5_BESTE_ZEIT`, `SEKTOR1..5_KMH`, `TOPSPEED_KMH`.
  - `INPIT`, `CANCELLED`, `PITSTOPDURATION`, `PITIN_TIME`.
  - `WET`, `PRO`/`PROAM`/`AM`/`AMG`, `STINT`, `LAPINSTINT`, `THEORETISCHE_BESTZEIT`.
  - Up to **8 drivers** per car: `FAHRER1..8_NAME` / `_VORNAME` / `_NATION` / etc.

### Classes present (KLASSEKURZ)

SP9 PRO, SP9 PRO-, SP9 AM, SP7, SP4, SP3T, SP10, AT 1, VT2-RWD, VT2-F+4W,
V6, V5, V3, TCR, CUP2, CUP3, BMW M2, BMW M240, BMW 325i.

> Note: these are the **real** class short-names for this event and differ from the
> older synthetic 27-class set. When this CSV becomes the main data source, the
> Race-class dropdown + starting-grid class-name matching should key off these.
