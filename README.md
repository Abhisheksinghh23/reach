# Reach

**How far can a Bengaluru bus take you?** Drop a pin, pick a departure time and a travel budget, and every BMTC bus stop you can reach lights up, coloured by minutes of travel. Scrub the clock from midnight to midnight and watch the reachable area breathe. Add a second pin to find where two people can both get to, and where to meet.

Everything runs in the browser. There is no server and no API key.

> Timetable reach, not live arrivals. The data is BMTC's published schedule (via Vonter/bmtc-gtfs). Real buses run late, skip trips and get stuck in traffic.

## What is in it

- **A routing engine written from scratch** (`src/engine.ts`): the Connection Scan Algorithm. About 2 million timetable connections for a weekday are sorted by departure time once, then every pin drag is a single linear scan that stops as soon as the budget runs out. Typical scan: under 15 ms on a laptop.
- **Walking**: up to 1 km from your pin to the first stop, 250 m footpath transfers between stops, 4.5 km/h with a 1.3 street-distance factor. Straight-line distances, not street routing.
- **Journeys**: click any lit stop to see the fastest scheduled trip (legs, routes, times) found by tracing back through the scan.
- **Two-pin meeting**: bus stops reachable from both pins, ranked by the later of the two arrival times. These are balanced stops, not checked venues.
- **Day profile**: how many stops are reachable from pin A for every half hour of the day, computed live.
- **Shareable links**: pins, time, budget and day live in the URL hash.
- A web worker keeps the map smooth while scanning.

## Data pipeline

`prep.py` turns the GTFS feed into a 1.1 MB binary the browser can load:

1. Read `stop_times.txt`, `trips.txt`, `calendar.txt` (69,642 trips, 9,936 stops used).
2. Collapse trips into 8,999 patterns (same route, stops and relative timings) plus a start time and a weekday mask per trip.
3. Write typed arrays, gzipped. The browser rebuilds connections for the chosen weekday, including after-midnight trips from the previous day.

Rebuild it:

```
curl -L -o data/bmtc.zip https://raw.githubusercontent.com/Vonter/bmtc-gtfs/main/gtfs/bmtc.zip
unzip data/bmtc.zip -d data
python3 prep.py          # needs numpy; writes public/data/ (copy of docs/data/)
cp docs/data/NOTICE.md docs/data/ODbL-1.0.txt public/data/
npm install && npm run dev
```

Feed version used: 2026-11-09 to 2027-11-09. Every service in the feed has the same validity range and there are no date exceptions, so the weekday pattern is exact for that range. The app shows this and does not model holidays or special days.

## Tests

`node tests/engine.test.mjs` runs the engine on the real data: timing, after-midnight service, journey consistency (every traced leg starts after the previous one ends) and monotonic budgets. `node tests/e2e.mjs <url>` drives headless Chrome through the UI (needs `puppeteer-core` and Chrome).

## Limits

- Scheduled times only. No live positions, delays or cancellations.
- No fares, no accessibility info, no metro or rail.
- Walking is straight-line, not along streets or across barriers.
- Holidays and special days are not in the feed, so every Monday looks like every other Monday. Outside 9 Nov 2026 to 9 Nov 2027 the feed does not apply.
- Similar BMTC maps exist; this one is about the routing engine and the reach view with a time scrubber and two-pin meeting.

## Credits

- Timetable data: [Vonter/bmtc-gtfs](https://github.com/Vonter/bmtc-gtfs), compiled from BMTC, licensed [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1.0/).
  - `docs/data/` is a Derived Database of that feed and is offered under ODbL 1.0 (see `docs/data/NOTICE.md` and `docs/data/ODbL-1.0.txt`). `prep.py` is the alteration script and reproduces the files from the original feed.
  - The app display is a Produced Work: it keeps the attribution and licence notice in its footer.
  - Share-alike applies to the data files, not to the MIT application code, as long as the data stays a separate, clearly licensed file as it is here.
- Map tiles: © OpenStreetMap contributors (standard tile server, shown in a dark filter). Light personal use only; swap in your own tile provider for anything busy.
- Leaflet, Vite.

Code: MIT (everything except `docs/data/`, which is ODbL 1.0).
