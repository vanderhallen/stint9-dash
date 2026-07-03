# STINT9-dash — Source Protection & Monetization Plan

_Last updated: 2026-07-03_

## Goal

Protect stint9-dash from being copied, and set it up so access can be sold —
users keep using the service instead of cloning or bypassing it.

## The one hard truth

Anything the browser runs (HTML/CSS/JS), the user can read. There is no way to
fully "shield" a client-side site. The real levers are:

1. Make copying not worth it (deterrence).
2. Make the valuable part impossible to steal (move it off the client).

## What stint9-dash is today (assessment)

- Single self-contained `index.html` (~900 KB), also duplicated as
  `stint9_dashboard.html`. Static site, **no backend**.
- The entire payload is one line: `const DB = {...}` — an ~828 KB JS object
  holding the digitized Nürburgring track (`poly` polygon = thousands of
  coordinate points, sector layout, `W/H` dimensions). **This is the crown
  jewel and it sits in plain text in the browser** — copyable in seconds.
- External calls: Leaflet, Google Fonts, `api.rainviewer.com` (public weather,
  no key). All harmless.
- ✅ No API keys / tokens / passwords / base64 secrets baked in.
- ✅ `source/` (raw CSV, PDF, backups) is gitignored — not in the repo.

### Two assets, two realities

| Asset | Where it lives | Hideable client-side? |
|---|---|---|
| Visuals/animation (SVG render, gauges, flow) | JS in browser | Partly — obfuscation deters casual cloning |
| Data/logic (`const DB` track model) | JS object in browser | **No** — fully exposed, needs a backend |

## Done — Phase 1 (lock it down now)

- [x] **Repo set to PRIVATE** (2026-07-03) — source, history, comments no longer
      publicly readable. _(Does nothing for the deployed site's shipped code.)_

### Optional Phase 1 extras (deterrence only — not yet done)

- Obfuscate/minify the deployed HTML — deters copy-paste of the renderer.
  Downside: complicates editing the 900 KB file. Only buys deterrence.
- Encode the `const DB` blob — speed bump only; a determined person still dumps
  it from DevTools memory. Not worth the hassle yet.

> Honest note: none of these hide the data or logic from someone who opens
> DevTools. Only Phase 2 does that.

## Phase 2 — the real fix (when ready to sell)

Move `const DB` off the client. Browser gets the **renderer**; the **track data**
comes from a server that only answers paying, logged-in users.

```
Visitor ──▶ Cloudflare Pages (HTML/JS shell, NO DB)
              │  fetch('/api/track', with login cookie)
              ▼
          Cloudflare Worker ──▶ valid paying user?
              │ yes                 │ no → 401, empty page
              ▼
          KV / R2  (const DB lives here, never shipped to non-users)
```

### Steps & effort

| Step | Effort | Notes |
|---|---|---|
| Split `DB` out of HTML into KV/R2 | ~½ day | Mechanical, low risk |
| Gatekeeper Worker at `/api/track` | ~½ day | ~50 lines |
| Login + payments — **buy** (Clerk/Auth0 + Stripe/Lemon Squeezy) | 1–2 days | Fastest, small monthly cost |
| Login + payments — **build** (Cloudflare Access / Worker + KV sessions) | 3–5 days | Cheaper, more edge cases |
| Slice-only DB delivery (optional) | +1 day | Skip until piracy actually happens |

**Realistic total: ~2–3 days** using off-the-shelf auth+billing; more if self-built.

### What Phase 2 achieves

- ✅ `const DB` becomes genuinely protected — a copycat must rebuild the whole
  dataset from scratch.
- ✅ Access can be sold; non-payers get an empty shell.
- ⚠️ Renderer JS still copyable — but worthless without the data. Don't
  over-invest in hiding it.
- ⚠️ A paying user can still dump the DB from their own browser once. No system
  stops a legitimate logged-in user. If that ever matters: per-user
  watermarking / tracking as a deterrent.

### The decision that drives everything

**Buy vs. build** auth + payments — difference between ~2 and ~5 days, and it
sets the monthly cost structure. Pin this down first when starting Phase 2.
