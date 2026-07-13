# Message to send the stint9 owner

We built a race-engineering overlay for our team on top of stint9's live timing
(maps, position chart, sector deltas). It reads stint9's own JSON feed from a
logged-in browser tab. To finish wiring it we need to confirm a few details of
the `/api/worker/...` endpoints. You can either **run a tiny read-only probe**
(Option A) or **just answer the 5 questions** (Option B) — whichever is easier.

---

## Option A — run the probe (30 seconds, read-only, writes nothing)
During a **live session** (practice/quali/race), while logged in on the live
timing page:
1. Open DevTools → **Console** (⌥⌘I on Mac, F12 on Windows).
2. Paste the contents of **`probe.js`** (attached) and press Enter.
3. Copy the whole console output back to us.

It just does the same `GET /api/worker/events/{eventId}/laps` the page already
does, and prints: the detected `eventId`, one sample lap object, and how `todTs`
parses. **It sends nothing anywhere and changes nothing** — it's your session,
your data, read-only.

---

## Option B — just answer these 5 (you know them by heart)
1. **eventId** — what's its format, and where does the app get it (route param?
   an events-list endpoint like `/api/worker/events`)? If handy, the id of a
   recent or upcoming event so we can test.
2. **Sample lap** — one raw object from `/api/worker/events/{eventId}/laps`. We
   think the fields are: `stnr, className, driverName, car, lap, lapTime,
   s1Time…s5Time, todTs, pitStopCount, position, classRank` — is that right?
3. **`todTs`** — what is it exactly? epoch-milliseconds, an ISO string, or
   seconds-of-day? (We convert it to time-of-day to place cars on track.)
4. **Auth / sessions** — is the feed the same during quali and race, and do the
   `/api/worker/...` calls need anything beyond the normal Clerk session cookie?
5. **Etiquette** — any objection to us polling
   `/api/worker/events/{id}/laps` from a logged-in tab about **every 5 s**
   during the event (read-only)? Or would you rather give us a read-only token
   or a lighter endpoint? We don't want to hammer your backend.

---

Thanks! Read-only either way — we're not scraping WIGE or touching your writes,
just mirroring the data you already serve us into our own view.
