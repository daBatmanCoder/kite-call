#!/usr/bin/env python3
"""Fetch Open-Meteo, score sessions, write forecasts.json + THIS_WEEK.md."""
from __future__ import annotations

import json
import math
import urllib.request
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent
TZ = ZoneInfo("Europe/Amsterdam")
KN = 1.852
SESSION = range(10, 20)
COMPASS = ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"]

def deg_to_compass(deg):
    if deg is None:
        return "—"
    return COMPASS[round((deg % 360) / 22.5) % 16]

def circ_diff(a, b):
    d = abs(a - b) % 360
    return 360 - d if d > 180 else d

def kite_size(kn):
    if kn < 10: return "—"
    if kn < 13: return "~15–17m"
    if kn < 16: return "~12–14m"
    if kn < 19: return "~11–12m"
    if kn < 22: return "~9–10m"
    if kn < 26: return "~8–9m"
    if kn < 30: return "~7m"
    return "~5–7m"

def dir_quality(wind_from, spot):
    off = circ_diff(wind_from, spot["shoreFacing"])
    compass = deg_to_compass(wind_from)
    listed_best = compass in spot["bestDirs"]
    listed_danger = compass in spot["dangerDirs"]
    offshore = False
    if off >= 150:
        score, label, offshore = 0, "offshore", True
    elif off >= 125:
        score, label, offshore = 0.18, "side-offshore", True
    elif 70 <= off <= 110:
        score, label = 1, "sideshore"
    elif 40 <= off < 70:
        score, label = 0.88, "side-onshore"
    elif 110 < off < 125:
        score, label = 0.45, "side-off (risky)"
    else:
        score, label = 0.55, "onshore"
    if listed_best:
        score = min(1, score + 0.08)
    if listed_danger:
        score = min(score, 0.12)
        offshore = off >= 120 or listed_danger
    if compass in (spot.get("gustyDirs") or []):
        score *= 0.85
    return score, label, offshore, compass, off

def wind_speed_score(kn):
    if kn < 6: return 4
    if kn < 10: return 8 + (kn - 6) * 2
    if kn < 12: return 16 + (kn - 10) * 6
    if kn < 16: return 28 + (kn - 12) * 5
    if kn <= 22: return 50 - abs(kn - 19) * 0.6
    if kn <= 25: return 46 - (kn - 22) * 4
    if kn <= 30: return 34 - (kn - 25) * 4
    return max(4, 14 - (kn - 30))

def score_hours(hours, spot):
    if not hours:
        return dict(score=0, verdict="NO", why="No daylight hours", kn=0, gust=0, dir=0,
                    compass="—", dirLabel="—", offshore=True, kite="—")
    kns = [h["kn"] for h in hours]
    mean = sum(kns) / len(kns)
    mid = hours[len(hours)//2]
    gust_mean = sum(h["gustKn"] for h in hours) / len(hours)
    gust_factor = gust_mean / mean if mean > 0.5 else 2
    gust_score = 10 if gust_factor <= 1.25 else 7 if gust_factor <= 1.45 else 4 if gust_factor <= 1.7 else 1
    var = sum((v - mean)**2 for v in kns) / len(kns)
    stdev = math.sqrt(var)
    cons = 10 if stdev < 2 else 7 if stdev < 3.5 else 4 if stdev < 5 else 1
    dirs = [dir_quality(h["dir"], spot) for h in hours]
    dir_score = sum(d[0] for d in dirs) / len(dirs)
    offshore_share = sum(1 for d in dirs if d[2]) / len(dirs)
    w = wind_speed_score(mean)
    score = w * 0.95 + dir_score * 30 + gust_score + cons
    if offshore_share >= 0.5:
        score = min(score, 28)
    if mean < 10:
        score = min(score, 38)
    if mean > 32:
        score = min(score, 36)
    score = max(0, min(100, round(score)))
    verdict = "NO"
    if score >= 65 and offshore_share < 0.35 and mean >= 12:
        verdict = "GO"
    elif score >= 40 and offshore_share < 0.55 and mean >= 10:
        verdict = "MARGINAL"
    mid_dir = dirs[len(dirs)//2]
    bits = [f"{mean:.0f} kn {mid_dir[3]}", mid_dir[1]]
    if gust_factor > 1.5: bits.append("gusty")
    if stdev > 3.5: bits.append("on/off afternoon")
    if mean < 10: bits.append("too light")
    if mean > 28: bits.append("stormy / advanced")
    return dict(score=score, verdict=verdict, why=" · ".join(bits), kn=mean, gust=gust_mean,
                dir=mid["dir"], compass=deg_to_compass(mid["dir"]), dirLabel=mid_dir[1],
                offshore=offshore_share >= 0.45, kite=kite_size(mean))

def parse_loc(item):
    hours = []
    for i, t in enumerate(item["hourly"]["time"]):
        dt = datetime.fromisoformat(t).replace(tzinfo=TZ)
        hours.append({
            "iso": t,
            "date": dt.strftime("%Y-%m-%d"),
            "hour": dt.hour,
            "weekday": dt.strftime("%a"),
            "kmh": item["hourly"]["wind_speed_10m"][i],
            "kn": item["hourly"]["wind_speed_10m"][i] / KN,
            "gustKmh": item["hourly"]["wind_gusts_10m"][i],
            "gustKn": item["hourly"]["wind_gusts_10m"][i] / KN,
            "dir": item["hourly"]["wind_direction_10m"][i],
            "weather": item["hourly"]["weather_code"][i],
        })
    by_day = {}
    for h in hours:
        by_day.setdefault(h["date"], []).append(h)
    cur = item.get("current")
    current = None
    if cur:
        current = {
            "kn": cur["wind_speed_10m"] / KN,
            "gustKn": cur["wind_gusts_10m"] / KN,
            "dir": cur["wind_direction_10m"],
            "compass": deg_to_compass(cur["wind_direction_10m"]),
            "weather": cur.get("weather_code"),
            "time": cur.get("time"),
        }
    return {"hours": hours, "byDay": by_day, "current": current,
            "sunrise": item.get("daily", {}).get("sunrise", []),
            "sunset": item.get("daily", {}).get("sunset", [])}

def sess(day_hours):
    return [h for h in day_hours if h["hour"] in SESSION]

def main():
    doc = json.loads((ROOT / "spots.json").read_text())
    points = [doc["home"], *doc["spots"]]
    lat = ",".join(str(p["lat"]) for p in points)
    lon = ",".join(str(p["lon"]) for p in points)
    url = (
        "https://api.open-meteo.com/v1/forecast?"
        f"latitude={lat}&longitude={lon}"
        "&hourly=wind_speed_10m,wind_direction_10m,wind_gusts_10m,weather_code"
        "&current=wind_speed_10m,wind_direction_10m,wind_gusts_10m,weather_code"
        "&daily=sunrise,sunset&timezone=Europe%2FAmsterdam"
        "&wind_speed_unit=kmh&forecast_days=7"
    )
    print("GET", url)
    with urllib.request.urlopen(url, timeout=45) as r:
        api = json.loads(r.read().decode())
    if not isinstance(api, list):
        api = [api]
    locations = {}
    for p, item in zip(points, api):
        locations[p["id"]] = parse_loc(item)

    dates = sorted(locations[doc["spots"][0]["id"]]["byDay"].keys())
    winners = []
    for date in dates:
        best = None
        for spot in doc["spots"]:
            s = score_hours(sess(locations[spot["id"]]["byDay"].get(date, [])), spot)
            row = {"date": date, "spotId": spot["id"], "spotName": spot["name"],
                   "driveMin": spot["driveMin"], **s}
            if best is None or row["score"] > best["score"] or (
                row["score"] == best["score"] and spot["driveMin"] < best["driveMin"]
            ):
                best = row
        winners.append(best)

    hero = max(winners, key=lambda w: (w["score"], -w["driveMin"]))
    fetched = datetime.now(TZ).isoformat(timespec="minutes")

    compact_loc = {}
    for pid, loc in locations.items():
        compact_loc[pid] = {
            "current": loc["current"],
            "sunrise": loc["sunrise"],
            "sunset": loc["sunset"],
            "days": {
                d: [
                    {"h": h["hour"], "kn": round(h["kn"], 2), "gust": round(h["gustKn"], 2),
                     "dir": h["dir"], "wx": h["weather"]}
                    for h in hours
                ]
                for d, hours in loc["byDay"].items()
            },
        }

    out = {
        "fetchedAt": fetched,
        "timezone": "Europe/Amsterdam",
        "source": url,
        "units": {"wind": "stored as knots in compact days; API was km/h"},
        "winners": winners,
        "hero": hero,
        "locations": compact_loc,
        "api": api,
        "points": [{"id": p["id"], "lat": p["lat"], "lon": p["lon"]} for p in points],
    }
    (ROOT / "forecasts.json").write_text(json.dumps(out, indent=2))

    lines = [
        "# This week’s kite call",
        "",
        f"Snapshot: **{fetched}** Europe/Amsterdam. Model: Open-Meteo 10 m wind (km/h converted to knots / 1.852).",
        "Session window: **10:00–19:00** local. Score 0–100; GO ≥65, MARGINAL ≥40, else NO. Offshore sessions are capped.",
        "",
        f"## The call: {hero['verdict']} — {hero['spotName']} on {hero['date']}",
        "",
        f"{hero['why']}. Score **{hero['score']}**. ~{hero['kn']:.0f} kn (gust ~{hero['gust']:.0f}), {hero['compass']} {hero['dirLabel']}, kite {hero['kite']}, drive {hero['driveMin']} min.",
        "",
        "## Daily winner table",
        "",
        "| Day | Spot | kn | Dir | Score | Verdict | Why |",
        "|---|---|---:|---|---:|---|---|",
    ]
    for w in winners:
        wd = datetime.strptime(w["date"], "%Y-%m-%d").strftime("%a %d %b")
        lines.append(
            f"| {wd} | {w['spotName']} | {w['kn']:.0f} | {w['compass']} | {w['score']} | {w['verdict']} | {w['why']} |"
        )

    lines += ["", "## Area notes (same week)", ""]
    areas = [
        ("Near Amsterdam", ["muiderberg", "hoorn-schellinkhout"]),
        ("North Sea (near / mid)", ["zandvoort", "ouddorp"]),
        ("Brouwersdam", ["brouwersdam-south", "brouwersdam-north"]),
        ("Grevelingen / Krammer", ["grevelingendam-north", "grevelingendam-south"]),
        ("Walcheren / Roompot", ["vrouwenpolder", "neeltje-jans", "roompot", "domburg"]),
        ("Zeeuws-Vlaanderen", ["cadzand"]),
    ]
    home = locations["amsterdam"]
    for title, ids in areas:
        lines.append(f"### {title}")
        lines.append("")
        for sid in ids:
            spot = next(s for s in doc["spots"] if s["id"] == sid)
            lines.append(f"**{spot['name']}** ({spot['lat']}, {spot['lon']}) best {', '.join(spot['bestDirs'])}")
            for date in dates:
                s = score_hours(sess(locations[sid]["byDay"].get(date, [])), spot)
                hd = sess(home["byDay"].get(date, []))
                hkn = sum(h["kn"] for h in hd) / len(hd) if hd else 0
                lines.append(
                    f"- {date}: {s['verdict']} {s['score']} · {s['kn']:.0f} kn {s['compass']} ({s['dirLabel']}) · "
                    f"home {hkn:.0f} kn · {s['kite']}"
                )
            lines.append("")

    lines += [
        "## Caveats",
        "",
        "- Tide is not modelled. Vrouwenpolder lagoon, Neeltje Jans, Zandvoort, Ouddorp, Domburg, Cadzand are tide-sensitive.",
        "- Schelphoek, Kattendijke and Wemeldinge are **not** official kite spots (Oosterschelde Natura 2000). Not included.",
        "- Krabbendijke / Roelshoek is permanently closed.",
        "- Hoorn town beach is not official; table uses Schellinkhout.",
        "- Brouwersdam North coordinate is the Grevelingen mid-dam lake side (launches spread along P-lots), not a single NKV pole.",
        "- Grevelingendam North is closed 1 Nov–15 Mar.",
        "- 10 m model wind is often a few knots off the beach, especially inland (Muiderberg / Schellinkhout gustier than the model).",
        "- Not a replacement for KNMI warnings or local schools/spot hosts.",
        "",
    ]
    (ROOT / "THIS_WEEK.md").write_text("\n".join(lines))
    print("Wrote forecasts.json and THIS_WEEK.md")
    print("HERO", hero["date"], hero["spotName"], hero["score"], hero["verdict"], f"{hero['kn']:.1f}kn", hero["compass"])
    for w in winners:
        print(w["date"], w["spotName"], f"{w['kn']:.0f}kn", w["compass"], w["score"], w["verdict"])

if __name__ == "__main__":
    main()
