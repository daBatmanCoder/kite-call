const TZ = "Europe/Amsterdam";
const KN = 1.852;
const SESSION_START = 10;
const SESSION_END = 19;

const COMPASS = ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"];
const DIR_DEG = { N:0, NNE:22.5, NE:45, ENE:67.5, E:90, ESE:112.5, SE:135, SSE:157.5, S:180, SSW:202.5, SW:225, WSW:247.5, W:270, WNW:292.5, NW:315, NNW:337.5 };

let SPOTS_DOC = null;
let RAW = null;
let FILTER = "all";
let ACTIVE_DAY = null;

function degToCompass(deg) {
  if (deg == null || Number.isNaN(deg)) return "—";
  return COMPASS[Math.round(((deg % 360) / 22.5)) % 16];
}
function circDiff(a, b) {
  let d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}
function kmhToKn(v) { return v / KN; }

function kiteSize(kn) {
  if (kn < 10) return "—";
  if (kn < 13) return "~15–17m";
  if (kn < 16) return "~12–14m";
  if (kn < 19) return "~11–12m";
  if (kn < 22) return "~9–10m";
  if (kn < 26) return "~8–9m";
  if (kn < 30) return "~7m";
  return "~5–7m";
}

function hourInAmsterdam(iso) {
  const d = new Date(iso);
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", hourCycle: "h23", weekday: "short"
  }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t).value;
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    hour: Number(get("hour")),
    weekday: get("weekday"),
    iso
  };
}

function dirQuality(windFrom, spot) {
  if (spot.shoreFacing == null) return { score: 0, label: "n/a", offshore: false };
  const offAngle = circDiff(windFrom, spot.shoreFacing);
  const compass = degToCompass(windFrom);
  const listedBest = spot.bestDirs.includes(compass);
  const listedDanger = spot.dangerDirs.includes(compass);
  let score, label, offshore = false;
  if (offAngle >= 150) { score = 0; label = "offshore"; offshore = true; }
  else if (offAngle >= 125) { score = 0.18; label = "side-offshore"; offshore = true; }
  else if (offAngle >= 70 && offAngle <= 110) { score = 1; label = "sideshore"; }
  else if (offAngle >= 40 && offAngle < 70) { score = 0.88; label = "side-onshore"; }
  else if (offAngle > 110 && offAngle < 125) { score = 0.45; label = "side-off (risky)"; }
  else { score = 0.55; label = "onshore"; }
  if (listedBest) score = Math.min(1, score + 0.08);
  if (listedDanger) { score = Math.min(score, 0.12); offshore = offAngle >= 120 || listedDanger; }
  if (spot.gustyDirs && spot.gustyDirs.includes(compass)) score *= 0.85;
  return { score, label, offshore, compass, offAngle };
}

function windSpeedScore(kn) {
  if (kn < 6) return 4;
  if (kn < 10) return 8 + (kn - 6) * 2;
  if (kn < 12) return 16 + (kn - 10) * 6;
  if (kn < 16) return 28 + (kn - 12) * 5;
  if (kn <= 22) return 50 - Math.abs(kn - 19) * 0.6;
  if (kn <= 25) return 46 - (kn - 22) * 4;
  if (kn <= 30) return 34 - (kn - 25) * 4;
  return Math.max(4, 14 - (kn - 30));
}

function scoreHours(hours, spot) {
  if (!hours.length) return { score: 0, verdict: "NO", why: "No daylight hours", kn: 0, gust: 0, dir: 0, compass: "—", dirLabel: "—", offshore: true, kite: "—", consistency: 0 };
  const kns = hours.map((h) => h.kn);
  const mean = kns.reduce((a, b) => a + b, 0) / kns.length;
  const mid = hours[Math.floor(hours.length / 2)];
  const gustMean = hours.reduce((a, h) => a + h.gustKn, 0) / hours.length;
  const gustFactor = mean > 0.5 ? gustMean / mean : 2;
  const gustScore = gustFactor <= 1.25 ? 10 : gustFactor <= 1.45 ? 7 : gustFactor <= 1.7 ? 4 : 1;
  const variance = kns.reduce((a, v) => a + (v - mean) ** 2, 0) / kns.length;
  const stdev = Math.sqrt(variance);
  const consScore = stdev < 2 ? 10 : stdev < 3.5 ? 7 : stdev < 5 ? 4 : 1;
  const dirs = hours.map((h) => dirQuality(h.dir, spot));
  const dirScore = dirs.reduce((a, d) => a + d.score, 0) / dirs.length;
  const offshoreShare = dirs.filter((d) => d.offshore).length / dirs.length;
  const wScore = windSpeedScore(mean);
  let score = wScore * 0.95 + dirScore * 30 + gustScore + consScore;
  if (offshoreShare >= 0.5) score = Math.min(score, 28);
  if (mean < 10) score = Math.min(score, 38);
  if (mean > 32) score = Math.min(score, 36);
  score = Math.max(0, Math.min(100, Math.round(score)));
  let verdict = "NO";
  if (score >= 65 && offshoreShare < 0.35 && mean >= 12) verdict = "GO";
  else if (score >= 40 && offshoreShare < 0.55 && mean >= 10) verdict = "MARGINAL";
  const whyBits = [];
  whyBits.push(`${mean.toFixed(0)} kn ${dirs[Math.floor(dirs.length/2)].compass}`);
  whyBits.push(dirs[Math.floor(dirs.length/2)].label);
  if (gustFactor > 1.5) whyBits.push("gusty");
  if (stdev > 3.5) whyBits.push("on/off afternoon");
  if (mean < 10) whyBits.push("too light");
  if (mean > 28) whyBits.push("stormy / advanced");
  return {
    score, verdict,
    why: whyBits.join(" · "),
    kn: mean, gust: gustMean, dir: mid.dir,
    compass: degToCompass(mid.dir),
    dirLabel: dirs[Math.floor(dirs.length/2)].label,
    offshore: offshoreShare >= 0.45,
    kite: kiteSize(mean),
    consistency: consScore,
    hours
  };
}

function extractLocation(apiItem) {
  const times = apiItem.hourly.time;
  const hours = times.map((t, i) => {
    const loc = hourInAmsterdam(t);
    return {
      ...loc,
      kmh: apiItem.hourly.wind_speed_10m[i],
      kn: kmhToKn(apiItem.hourly.wind_speed_10m[i]),
      gustKmh: apiItem.hourly.wind_gusts_10m[i],
      gustKn: kmhToKn(apiItem.hourly.wind_gusts_10m[i]),
      dir: apiItem.hourly.wind_direction_10m[i],
      weather: apiItem.hourly.weather_code[i]
    };
  });
  const byDay = {};
  for (const h of hours) {
    (byDay[h.date] ||= []).push(h);
  }
  return {
    hours, byDay,
    current: apiItem.current ? {
      kn: kmhToKn(apiItem.current.wind_speed_10m),
      gustKn: kmhToKn(apiItem.current.wind_gusts_10m),
      dir: apiItem.current.wind_direction_10m,
      compass: degToCompass(apiItem.current.wind_direction_10m),
      weather: apiItem.current.weather_code,
      time: apiItem.current.time
    } : null,
    sunrise: apiItem.daily?.sunrise || [],
    sunset: apiItem.daily?.sunset || []
  };
}

function sessionHours(dayHours) {
  return dayHours.filter((h) => h.hour >= SESSION_START && h.hour <= SESSION_END);
}

function allSpots() { return SPOTS_DOC.spots; }
function home() { return SPOTS_DOC.home; }

function scoredWeek(spot, loc) {
  const days = Object.keys(loc.byDay).sort();
  return days.map((date) => {
    const sess = sessionHours(loc.byDay[date]);
    return { date, ...scoreHours(sess, spot), weekday: sess[0]?.weekday || hourInAmsterdam(date + "T12:00:00").weekday };
  });
}

function pickWinners(locations) {
  const spots = allSpots();
  const dates = Object.keys(locations[spots[0].id].byDay).sort();
  return dates.map((date) => {
    let best = null;
    for (const spot of spots) {
      const sess = sessionHours(locations[spot.id].byDay[date] || []);
      const weekday = sess[0]?.weekday || hourInAmsterdam(date + "T12:00:00").weekday;
      const s = { spot, date, weekday, ...scoreHours(sess, spot) };
      if (!best || s.score > best.score || (s.score === best.score && spot.driveMin < best.spot.driveMin)) best = s;
    }
    return best;
  });
}

function weekHero(winners) {
  let best = null;
  for (const w of winners) {
    if (!best || w.score > best.score || (w.score === best.score && w.spot.driveMin < best.spot.driveMin)) best = w;
  }
  return best;
}

function fmtDate(date) {
  const [y, m, d] = date.split("-");
  return `${d}/${m}`;
}

function arrowHtml(deg) {
  return `<span class="arrow" title="${degToCompass(deg)} ${Math.round(deg)}°"><i style="--deg:${deg}deg">↓</i></span>`;
}

function render(locations, sourceLabel) {
  const winners = pickWinners(locations);
  const hero = weekHero(winners);
  ACTIVE_DAY = ACTIVE_DAY || winners[0]?.date;
  const homeLoc = locations.amsterdam;
  const homeNow = homeLoc.current;
  const status = document.getElementById("status");
  status.className = "status " + (sourceLabel === "live" ? "live" : "cache");
  status.textContent = sourceLabel === "live"
    ? "Live Open-Meteo · Europe/Amsterdam · 10 m wind"
    : "Showing saved snapshot (live fetch failed) · Europe/Amsterdam";

  document.getElementById("stamp").innerHTML = `Updated <strong>${new Date().toLocaleString("nl-NL", { timeZone: TZ })}</strong> · ${TZ}`;

  const heroEl = document.getElementById("hero");
  if (hero) {
    const homeDay = sessionHours(homeLoc.byDay[hero.date] || []);
    const homeKn = homeDay.length ? (homeDay.reduce((a,h)=>a+h.kn,0)/homeDay.length) : 0;
    heroEl.innerHTML = `
      <div class="hero-label">This week's call</div>
      <h2>${hero.verdict === "GO" ? "Go" : hero.verdict === "MARGINAL" ? "Maybe" : "Stay home"}: ${hero.spot.name} · ${hero.weekday} ${fmtDate(hero.date)}</h2>
      <p class="hero-why">${hero.why}. ${hero.spot.water}. About ${hero.spot.driveMin} min from Amsterdam. ${hero.offshore ? "Direction looks risky — treat as no-go if it is offshore on the beach." : "Angle: " + hero.dirLabel + "."} At home that afternoon is ~${homeKn.toFixed(0)} kn vs ~${hero.kn.toFixed(0)} kn at the water.</p>
      <div class="hero-stats">
        <div class="stat"><span>Score</span><b>${hero.score}</b><div class="sub">${hero.verdict}</div></div>
        <div class="stat"><span>Wind</span><b>${hero.kn.toFixed(0)} kn</b><div class="sub">${(hero.kn*KN).toFixed(0)} km/h · gust ${hero.gust.toFixed(0)}</div></div>
        <div class="stat"><span>Direction</span><b>${hero.compass}</b><div class="sub">${hero.dirLabel} · ${Math.round(hero.dir)}°</div></div>
        <div class="stat"><span>Kite (approx)</span><b>${hero.kite}</b><div class="sub">80 kg rider ballpark</div></div>
        <div class="stat"><span>Drive</span><b>${hero.spot.driveMin} min</b><div class="sub">${hero.spot.regionLabel}</div></div>
      </div>`;
  }

  document.getElementById("week").innerHTML = winners.map((w) => `
    <button class="daycard ${w.date===ACTIVE_DAY?"active":""}" data-date="${w.date}">
      <div class="dow">${w.spot ? (sessionHours(locations[w.spot.id].byDay[w.date])[0]||{}).weekday || "" : ""}</div>
      <div class="dnum">${fmtDate(w.date)}</div>
      <div class="win">${w.spot.short}</div>
      <div class="wx">${arrowHtml(w.dir)} ${w.kn.toFixed(0)} kn · ${w.score}
        <span class="pill ${w.verdict.toLowerCase()}">${w.verdict}</span>
      </div>
    </button>`).join("");

  document.querySelectorAll(".daycard").forEach((el) => {
    el.onclick = () => { ACTIVE_DAY = el.dataset.date; render(locations, sourceLabel); };
  });

  const nowSpot = allSpots().find((s) => s.id === "zandvoort") || allSpots()[0];
  const coastNow = locations[nowSpot.id]?.current;
  document.getElementById("compare").innerHTML = homeNow && coastNow
    ? `At home it’s <em>${homeNow.kn.toFixed(0)} kn ${homeNow.compass}</em> · ${nowSpot.short} <em>${coastNow.kn.toFixed(0)} kn ${coastNow.compass}</em>`
    : "Current wind loading…";

  const list = allSpots().filter((s) => {
    if (FILTER === "all") return true;
    if (FILTER === "near") return s.region === "near";
    if (FILTER === "northsea") return s.region === "northsea" || s.id.startsWith("brouwersdam-south") || s.id === "neeltje-jans" || s.id === "vrouwenpolder";
    if (FILTER === "zeeland") return s.region === "zeeland" || ["ouddorp","domburg","cadzand"].includes(s.id);
    return true;
  });

  document.getElementById("spots").innerHTML = list.map((spot) => {
    const loc = locations[spot.id];
    const week = scoredWeek(spot, loc);
    const focus = week.find((d) => d.date === ACTIVE_DAY) || week[0];
    const uniqueHours = [];
    const seen = new Set();
    for (const h of sessionHours(loc.byDay[ACTIVE_DAY] || [])) {
      if (h.hour % 3 === 1 || h.hour === 10 || h.hour === 19) {
        if (!seen.has(h.hour)) { seen.add(h.hour); uniqueHours.push(h); }
      }
    }
    const rows = (uniqueHours.length ? uniqueHours : sessionHours(loc.byDay[ACTIVE_DAY] || [])).map((h) => {
      const width = Math.min(100, (h.kn / 30) * 100);
      return `<div class="hour">
        <div>${String(h.hour).padStart(2,"0")}:00</div>
        ${arrowHtml(h.dir)}
        <div class="bar"><i style="width:${width}%"></i></div>
        <div class="kn">${h.kn.toFixed(0)} kn</div>
        <div class="gust">G ${h.gustKn.toFixed(0)}</div>
        <div class="kite">${kiteSize(h.kn)}</div>
      </div>`;
    }).join("");
    const weekStrip = week.map((d) => `${d.weekday.slice(0,2)} ${d.score}`).join(" · ");
    return `<article class="spot" data-id="${spot.id}">
      <button class="spot-head">
        <div>
          <div class="spot-title">${spot.name}</div>
          <div class="spot-sub">${spot.regionLabel} · faces ${spot.shoreCompass} (${spot.shoreFacing}°) · ${spot.driveMin} min</div>
        </div>
        <span class="pill ${focus.verdict.toLowerCase()}">${focus.verdict} ${focus.score}</span>
        <div class="score">${focus.kn.toFixed(0)}<small> kn</small></div>
      </button>
      <div class="spot-body">
        <div class="dirs">
          ${spot.bestDirs.map((d)=>`<span class="tag">best ${d}</span>`).join("")}
          ${spot.dangerDirs.map((d)=>`<span class="tag bad">no ${d}</span>`).join("")}
        </div>
        <p class="notes">${spot.notes}</p>
        <div class="hours">${rows}</div>
        <div class="legend">3-hourly-ish daylight (${SESSION_START}:00–${SESSION_END}:00 ${TZ}). Week scores: ${weekStrip}. Kite sizes are rough for an ~80 kg rider — not a quiver prescription. ${spot.level}.</div>
      </div>
    </article>`;
  }).join("");

  document.querySelectorAll(".spot-head").forEach((btn) => {
    btn.onclick = () => btn.parentElement.classList.toggle("open");
  });
}

function openMeteoUrl(points) {
  const lat = points.map((p) => p.lat).join(",");
  const lon = points.map((p) => p.lon).join(",");
  const params = new URLSearchParams({
    latitude: lat, longitude: lon,
    hourly: "wind_speed_10m,wind_direction_10m,wind_gusts_10m,weather_code",
    current: "wind_speed_10m,wind_direction_10m,wind_gusts_10m,weather_code",
    daily: "sunrise,sunset",
    timezone: TZ,
    wind_speed_unit: "kmh",
    forecast_days: "7"
  });
  return `https://api.open-meteo.com/v1/forecast?${params}`;
}

function attachLocations(apiList, points) {
  const locations = {};
  apiList.forEach((item, i) => { locations[points[i].id] = extractLocation(item); });
  return locations;
}

async function boot() {
  const spotsRes = await fetch("./spots.json");
  SPOTS_DOC = await spotsRes.json();
  const points = [home(), ...allSpots()];

  document.querySelectorAll(".chip").forEach((chip) => {
    chip.onclick = () => {
      FILTER = chip.dataset.filter;
      document.querySelectorAll(".chip").forEach((c) => c.classList.toggle("active", c === chip));
      if (RAW) render(RAW, window.__src || "live");
    };
  });

  try {
    const res = await fetch(openMeteoUrl(points));
    if (!res.ok) throw new Error("API " + res.status);
    const json = await res.json();
    const list = Array.isArray(json) ? json : [json];
    RAW = attachLocations(list, points);
    window.__src = "live";
    render(RAW, "live");
  } catch (err) {
    const snap = await fetch("./forecasts.json").then((r) => r.json());
    RAW = snap.locations ? snap.locations : attachLocations(snap.api, points);
    if (snap.locations && snap.locations[points[0].id]?.hours) {
    } else if (snap.api) {
      RAW = attachLocations(snap.api, points);
    }
    window.__src = "cache";
    render(RAW, "cache");
    console.warn(err);
  }
}

boot();
