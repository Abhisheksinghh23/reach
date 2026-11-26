# Data notice

The files in this folder (`reach.bin.gz`, `reach-meta.json.gz`) are a **Derived Database** of
[Vonter/bmtc-gtfs](https://github.com/Vonter/bmtc-gtfs) (BMTC timetables, feed version 2026-11-09),
made available under the **Open Database License (ODbL) 1.0**: https://opendatacommons.org/licenses/odbl/1.0/
(full text in `ODbL-1.0.txt`).

What was changed: only stops and trips used in stop_times were kept; stop names, rounded coordinates, route short names and
descriptions, per-trip weekday masks, and stop sequences with relative arrival and departure offsets were re-encoded into
compact binary and gzip. Trips with identical route, stops and timings were merged into patterns. The script that makes these
files from the original feed is `prep.py` in the repository root (the alteration is fully reproducible from the original data).

Original database: Vonter / Bengaluru Metropolitan Transport Corporation. Contents are not individually licensed beyond the ODbL.
The Reach application code is MIT licensed; the app display is a Produced Work and carries the attribution shown in its footer.
