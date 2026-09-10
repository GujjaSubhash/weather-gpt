"""
Download the training data for the Hyderabad flood-risk model.

Two independent series, both from Open-Meteo (free, no API key, CC-BY 4.0):

  1. Hourly precipitation, ERA5 reanalysis (~25 km grid). These become the
     model's FEATURES — rainfall is what the app can actually observe at
     request time, so it is the only thing the model is allowed to learn from.

  2. Daily river discharge, GloFAS reanalysis (ECMWF's Global Flood Awareness
     System). This becomes the LABEL.

Why the label comes from a different system than the features is the whole
design. The obvious shortcut — call a day "flood" when rainfall crosses some
number — would train the model to reproduce the very threshold it is meant to
replace, and the evaluation would look great while meaning nothing. GloFAS is
an independent hydrological model, so "rainfall pattern -> river response" is a
real relationship to learn rather than a restatement of the input.

Both series are cached to ml/data/. Re-running is cheap: an existing, complete
CSV is left alone unless --force is passed.

Usage:
    python ml/fetch_data.py            # fetch anything missing
    python ml/fetch_data.py --force    # re-download everything
"""

from __future__ import annotations

import argparse
import csv
import json
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

# Central Hyderabad. The app gates its flood framing to a metro bounding box
# (HYDERABAD_METRO in app/api/weather/route.ts); this is the middle of it.
LATITUDE = 17.385
LONGITUDE = 78.4867
TIMEZONE = "Asia/Kolkata"

# ERA5 begins in 1940 and GloFAS in 1984. Starting at 1985 gives both series a
# clean common span and 40 monsoons, which is the sample size that matters —
# flood days are rare, so years are the real currency here, not rows.
START_DATE = "1985-01-01"
END_DATE = "2024-12-31"

# Long hourly pulls time out server-side. Five-year blocks keep each request to
# ~44k rows, which Open-Meteo returns comfortably.
CHUNK_YEARS = 5

DATA_DIR = Path(__file__).parent / "data"
RAIN_CSV = DATA_DIR / "hyderabad_hourly_rain.csv"
DISCHARGE_CSV = DATA_DIR / "hyderabad_daily_discharge.csv"
META_JSON = DATA_DIR / "source_metadata.json"

ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive"
FLOOD_URL = "https://flood-api.open-meteo.com/v1/flood"

USER_AGENT = "weathergpt-ml/1.0 (research; contact via github.com/GujjaSubhash/weather-gpt)"


def get_json(url: str, params: dict, attempts: int = 4) -> dict:
    """GET with retry and backoff. Open-Meteo rate-limits by minute and hour."""
    query = urllib.parse.urlencode(params)
    full = f"{url}?{query}"
    last_err: Exception | None = None

    for attempt in range(1, attempts + 1):
        try:
            req = urllib.request.Request(full, headers={"User-Agent": USER_AGENT})
            # Some Windows Python installs ship without the system CA bundle
            # wired up; fall back to an unverified context only if the verified
            # one fails, and say so, rather than failing the whole download.
            try:
                with urllib.request.urlopen(req, timeout=180) as resp:
                    return json.loads(resp.read().decode("utf-8"))
            except ssl.SSLError:
                ctx = ssl._create_unverified_context()
                print("    ! TLS verification failed, retrying unverified", file=sys.stderr)
                with urllib.request.urlopen(req, timeout=180, context=ctx) as resp:
                    return json.loads(resp.read().decode("utf-8"))
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError) as err:
            last_err = err
            wait = 5 * attempt
            print(f"    ! attempt {attempt}/{attempts} failed ({err}); retrying in {wait}s",
                  file=sys.stderr)
            if attempt < attempts:
                time.sleep(wait)

    raise RuntimeError(f"gave up on {url} after {attempts} attempts") from last_err


def date_chunks(start: str, end: str, years: int):
    """Yield (start, end) date-string pairs covering [start, end] in blocks."""
    start_year = int(start[:4])
    end_year = int(end[:4])
    year = start_year
    while year <= end_year:
        block_end = min(year + years - 1, end_year)
        yield (
            start if year == start_year else f"{year}-01-01",
            end if block_end == end_year else f"{block_end}-12-31",
        )
        year = block_end + 1


def fetch_hourly_rain() -> list[tuple[str, float]]:
    """Hourly precipitation (mm) from ERA5, as (iso_time, mm) rows."""
    rows: list[tuple[str, float]] = []
    for chunk_start, chunk_end in date_chunks(START_DATE, END_DATE, CHUNK_YEARS):
        print(f"  rain {chunk_start} -> {chunk_end}")
        data = get_json(ARCHIVE_URL, {
            "latitude": LATITUDE,
            "longitude": LONGITUDE,
            "start_date": chunk_start,
            "end_date": chunk_end,
            "hourly": "precipitation",
            "timezone": TIMEZONE,
        })
        hourly = data["hourly"]
        times = hourly["time"]
        values = hourly["precipitation"]
        rows.extend(
            (t, 0.0 if v is None else float(v))
            for t, v in zip(times, values)
        )
        # Stay well inside the published free-tier limits.
        time.sleep(1.5)
    return rows


def fetch_daily_discharge() -> list[tuple[str, float | None]]:
    """Daily river discharge (m3/s) from GloFAS, as (iso_date, value) rows."""
    rows: list[tuple[str, float | None]] = []
    for chunk_start, chunk_end in date_chunks(START_DATE, END_DATE, CHUNK_YEARS * 2):
        print(f"  discharge {chunk_start} -> {chunk_end}")
        data = get_json(FLOOD_URL, {
            "latitude": LATITUDE,
            "longitude": LONGITUDE,
            "start_date": chunk_start,
            "end_date": chunk_end,
            "daily": "river_discharge",
        })
        daily = data["daily"]
        rows.extend(
            (t, None if v is None else float(v))
            for t, v in zip(daily["time"], daily["river_discharge"])
        )
        time.sleep(1.5)
    return rows


def write_csv(path: Path, header: tuple[str, str], rows) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as fh:
        writer = csv.writer(fh)
        writer.writerow(header)
        for row in rows:
            writer.writerow(["" if v is None else v for v in row])
    print(f"  wrote {path.name}: {len(rows):,} rows")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--force", action="store_true",
                        help="re-download even if the CSV already exists")
    args = parser.parse_args()

    DATA_DIR.mkdir(parents=True, exist_ok=True)

    if RAIN_CSV.exists() and not args.force:
        print(f"{RAIN_CSV.name} already present, skipping (use --force to refetch)")
    else:
        print("Fetching ERA5 hourly precipitation...")
        write_csv(RAIN_CSV, ("time", "precipitation_mm"), fetch_hourly_rain())

    if DISCHARGE_CSV.exists() and not args.force:
        print(f"{DISCHARGE_CSV.name} already present, skipping (use --force to refetch)")
    else:
        print("Fetching GloFAS daily river discharge...")
        write_csv(DISCHARGE_CSV, ("date", "river_discharge_m3s"), fetch_daily_discharge())

    META_JSON.write_text(json.dumps({
        "location": {"latitude": LATITUDE, "longitude": LONGITUDE, "timezone": TIMEZONE},
        "period": {"start": START_DATE, "end": END_DATE},
        "features_source": {
            "name": "ERA5 reanalysis via Open-Meteo Historical Weather API",
            "endpoint": ARCHIVE_URL,
            "variable": "precipitation (mm, hourly)",
            "resolution": "~25 km grid cell",
            "licence": "CC-BY 4.0",
        },
        "labels_source": {
            "name": "GloFAS reanalysis via Open-Meteo Flood API",
            "endpoint": FLOOD_URL,
            "variable": "river_discharge (m3/s, daily)",
            "licence": "CC-BY 4.0",
        },
    }, indent=2) + "\n", encoding="utf-8")
    print(f"  wrote {META_JSON.name}")

    print("\nDone. Next: python ml/train.py")
    return 0


if __name__ == "__main__":
    sys.exit(main())
