# Kite Call

Amsterdam kite-surf week call. Live Open-Meteo 10 m wind for Muiderberg, Hoorn / Schellinkhout, Zandvoort, and the main Zeeland kite beaches. Scores wind, angle vs the beach, and a daily go-here pick.

## Vercel

Import this repo in Vercel (framework: Other, output: static). Root is the site. No build step.

## Local

```bash
python3 -m http.server 8787
```

Open http://127.0.0.1:8787/ — live fetch needs network. Falls back to `forecasts.json` if Open-Meteo is blocked.

## Scoring (10:00–19:00 Europe/Amsterdam)

12–25 kn usable, 16–22 kn sweet, under 10 too light. Sideshore / side-onshore best. Offshore is a no-go. Kite size is a rough 80 kg hint. Not KNMI, not a tide table.
