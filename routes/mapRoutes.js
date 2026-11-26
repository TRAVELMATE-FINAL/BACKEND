// routes/mapRoutes.js
// Proxy endpoints for geocoding (Nominatim) and routing (OSRM).
// These are public free services — no API key needed.
// Server-side proxy is required because Nominatim/OSRM rate-limit by IP
// and require a User-Agent header.

const express = require("express");
const axios = require("axios");

const router = express.Router();

const UA = "TravelMate/1.0 (tescodigitals26@gmail.com)";

// ============================================================
// GET /api/geocode?q=Chennai
// → { lat, lon, display_name }
// ============================================================
router.get("/geocode", async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || !q.trim()) {
      return res.status(400).json({ error: "Query 'q' is required" });
    }

    const r = await axios.get("https://nominatim.openstreetmap.org/search", {
      params: { q, format: "json", limit: 1, addressdetails: 0 },
      headers: { "User-Agent": UA, "Accept-Language": "en" },
      timeout: 8000,
    });

    if (!Array.isArray(r.data) || r.data.length === 0) {
      return res.status(404).json({ error: "Location not found" });
    }

    const hit = r.data[0];
    return res.json({
      lat: parseFloat(hit.lat),
      lon: parseFloat(hit.lon),
      display_name: hit.display_name,
    });
  } catch (err) {
    console.error("geocode error:", err.message);
    const status = err.response?.status || 500;
    return res
      .status(status)
      .json({ error: err.response?.data?.error || "Geocode failed" });
  }
});

// ============================================================
// GET /api/autocomplete?q=tambaram
// → { results: [ { name, sub, display_name, lat, lon }, ... ] }
// Device-independent place search. Runs entirely server-side (Nominatim), so it
// works on phones / in-app browsers where the client-side Google Maps JS SDK is
// blocked by API-key referrer restrictions. Used by the location field as a
// fallback when Google autocomplete isn't available.
// ============================================================
// Google Places Text Search (New) — best quality + typo tolerance
// ("thambaram" → "Tambaram"). Runs server-side with a server key (NOT the
// browser key, which is HTTP-referrer restricted), so it works on every device.
// Returns places WITH coordinates in one call. Enabled only when a server key
// is configured: set GOOGLE_PLACES_API_KEY (or GOOGLE_MAPS_API_KEY) on the
// server to a key that has "Places API (New)" enabled and either no referrer
// restriction or an IP/none restriction.
const GOOGLE_KEY = process.env.GOOGLE_PLACES_API_KEY || process.env.GOOGLE_MAPS_API_KEY || "";
async function googleSearch(q) {
  if (!GOOGLE_KEY) return [];
  try {
    const r = await axios.post(
      "https://places.googleapis.com/v1/places:searchText",
      { textQuery: q, regionCode: "IN", languageCode: "en" },
      {
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": GOOGLE_KEY,
          "X-Goog-FieldMask": "places.displayName,places.formattedAddress,places.location",
        },
        timeout: 6000,
      }
    );
    const places = (r.data && r.data.places) || [];
    return places
      .map((p) => {
        const name = (p.displayName && p.displayName.text) || "";
        const addr = p.formattedAddress || "";
        const loc = p.location || {};
        // secondary = the address minus the leading name, for a clean subtitle.
        let sub = addr;
        if (name && addr.startsWith(name)) sub = addr.slice(name.length).replace(/^[,\s]+/, "");
        return {
          name: name || addr,
          sub: sub || "India",
          display_name: addr || name,
          lat: loc.latitude,
          lon: loc.longitude,
        };
      })
      .filter((r) => r.name && Number.isFinite(r.lat) && Number.isFinite(r.lon));
  } catch (e) {
    console.error("googleSearch error:", e.response?.status, e.response?.data?.error?.message || e.message);
    return [];
  }
}

// Photon (komoot) — free, no API key, built for type-ahead. Handles partial and
// slightly misspelled input ("thambara" → "Tambaram") far better than Nominatim.
async function photonSearch(q) {
  try {
    const r = await axios.get("https://photon.komoot.io/api/", {
      // Bias toward Tamil Nadu / South India so interior villages, localities and
      // streets rank well (Photon is strong at type-ahead for small places).
      params: { q, limit: 12, lang: "en", lat: 11.0, lon: 78.7 },
      headers: { "User-Agent": UA },
      timeout: 6000,
    });
    const feats = (r.data && r.data.features) || [];
    return feats
      .filter((f) => {
        const p = f.properties || {};
        return (p.countrycode === "IN") || /india/i.test(p.country || "");
      })
      .map((f) => {
        const p = f.properties || {};
        const coords = (f.geometry && f.geometry.coordinates) || [];
        const name = p.name || p.city || p.street || p.county || p.state || "";
        const subParts = [p.city, p.county, p.state, p.country]
          .filter((x) => x && x !== name);
        const sub = [...new Set(subParts)].join(", ") || "India";
        return {
          name,
          sub,
          display_name: [name, ...subParts].filter(Boolean).join(", "),
          lat: parseFloat(coords[1]),
          lon: parseFloat(coords[0]),
        };
      })
      .filter((r) => r.name && Number.isFinite(r.lat) && Number.isFinite(r.lon));
  } catch (e) {
    return [];
  }
}

// Nominatim backup.
async function nominatimSearch(q) {
  try {
    const r = await axios.get("https://nominatim.openstreetmap.org/search", {
      // countrycodes=in keeps it in India; addressdetails lets us label villages,
      // hamlets, suburbs and streets correctly (not just districts/cities).
      params: { q, format: "json", limit: 10, countrycodes: "in", addressdetails: 1, "accept-language": "en", dedupe: 1 },
      headers: { "User-Agent": UA, "Accept-Language": "en" },
      timeout: 6000,
    });
    const rows = Array.isArray(r.data) ? r.data : [];
    return rows.map((hit) => {
      const parts = String(hit.display_name || "").split(",").map((s) => s.trim());
      const a = hit.address || {};
      const name =
        a.city || a.town || a.village || a.suburb || a.neighbourhood ||
        a.county || a.state_district || a.hamlet || parts[0] || hit.display_name;
      const sub = parts.slice(1).join(", ") || "India";
      return { name, sub, display_name: hit.display_name, lat: parseFloat(hit.lat), lon: parseFloat(hit.lon) };
    });
  } catch (e) {
    return [];
  }
}

router.get("/autocomplete", async (req, res) => {
  const started = Date.now();
  try {
    const q = (req.query.q || "").trim();
    if (!q) return res.json({ results: [] });

    // Run Google (best, typo-tolerant — needs a server key) AND Photon (free,
    // excellent for interior villages / localities / streets) in PARALLEL so a
    // slow or failing Google key never blocks results. Prefer Google when it
    // returns; otherwise Photon; otherwise Nominatim. Each resolves to [] on
    // failure, so interior searches always get an answer (or a clean empty).
    const [g, p] = await Promise.all([
      googleSearch(q).catch(() => []),
      photonSearch(q).catch(() => []),
    ]);

    let results = [];
    let provider = "none";
    if (g.length) { results = g; provider = "google"; }
    else if (p.length) { results = p; provider = "photon"; }
    else {
      results = await nominatimSearch(q).catch(() => []);
      provider = results.length ? "nominatim" : "none";
    }

    const ms = Date.now() - started;
    console.log(`autocomplete q="${q}" -> ${provider} (${results.length}) ${ms}ms`);

    const payload = { results: results.slice(0, 8) };
    // ?debug=1 → see which provider served + whether the server Google key is
    // present, so key/restriction problems are diagnosable without code changes.
    if (req.query.debug) payload.debug = { provider, ms, hasGoogleKey: !!GOOGLE_KEY, counts: { google: g.length, photon: p.length } };
    return res.json(payload);
  } catch (err) {
    console.error("autocomplete error:", err.message);
    return res.json({ results: [] }); // never break the UI — just no suggestions
  }
});

// ============================================================
// POST /api/bus-nearby   { points: [{ lat, lon, name }] }
// → { nearby: [{ point, name, landmarks: [{ name, category, dist }] }] }
//
// Returns REAL nearby places (hospitals, colleges, railway/metro/bus stations,
// malls, attractions, temples) around each bus stop, straight from
// OpenStreetMap via the Overpass API. No invented/assumed data — only what OSM
// actually has. One batched Overpass query covers the whole route (all stops),
// and results are cached, so a route lookup makes at most one upstream call.
// ============================================================
const OVERPASS_URL = "https://overpass-api.de/api/interpreter";
const nearbyCache = new Map(); // key -> { t, data }
const NEARBY_TTL = 24 * 60 * 60 * 1000; // 24h

function metersBetween(aLat, aLon, bLat, bLon) {
  const R = 6371000;
  const toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(bLat - aLat), dLon = toRad(bLon - aLon);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

// Friendly category label from OSM tags.
function osmCategory(t) {
  if (!t) return "Landmark";
  if (t.railway === "station" || t.railway === "halt" || t.railway === "subway_entrance" || t.station === "subway") return "Railway / Metro";
  if (t.public_transport === "station") return "Station";
  if (t.amenity === "bus_station") return "Bus stand";
  if (t.amenity === "hospital" || t.amenity === "clinic") return "Hospital";
  if (t.amenity === "college" || t.amenity === "university") return "College";
  if (t.amenity === "school") return "School";
  if (t.amenity === "place_of_worship") return "Temple / Church / Mosque";
  if (t.amenity === "marketplace") return "Market";
  if (t.shop === "mall") return "Mall";
  if (t.tourism === "attraction" || t.tourism === "museum") return "Landmark";
  return "Landmark";
}

router.post("/bus-nearby", async (req, res) => {
  try {
    const raw = Array.isArray(req.body && req.body.points) ? req.body.points.slice(0, 30) : [];
    const pts = raw
      .map((p) => ({ lat: Number(p.lat), lon: Number(p.lon), name: String(p.name || "") }))
      .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
    if (!pts.length) return res.json({ nearby: [] });

    // Cache key = rounded coords of all points (a given route is stable).
    const key = pts.map((p) => p.lat.toFixed(3) + "," + p.lon.toFixed(3)).join("|");
    const hit = nearbyCache.get(key);
    if (hit && Date.now() - hit.t < NEARBY_TTL) return res.json({ nearby: hit.data });

    const R = 500; // metres around each stop
    const clauses = pts.map((p) => `
      nwr(around:${R},${p.lat},${p.lon})[amenity~"^(hospital|clinic|college|university|bus_station|marketplace|place_of_worship)$"][name];
      nwr(around:${R},${p.lat},${p.lon})[railway~"^(station|halt|subway_entrance)$"][name];
      nwr(around:${R},${p.lat},${p.lon})[public_transport=station][name];
      nwr(around:${R},${p.lat},${p.lon})[shop=mall][name];
      nwr(around:${R},${p.lat},${p.lon})[tourism~"^(attraction|museum)$"][name];
    `).join("\n");
    const query = `[out:json][timeout:25];(${clauses});out center 250;`;

    let elements = [];
    try {
      const r = await axios.post(OVERPASS_URL, "data=" + encodeURIComponent(query), {
        headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA },
        timeout: 20000,
      });
      elements = (r.data && r.data.elements) || [];
    } catch (e) {
      console.warn("overpass error:", e.response && e.response.status, e.message);
      return res.json({ nearby: pts.map((p, i) => ({ point: i, name: p.name, landmarks: [] })) });
    }

    const buckets = pts.map(() => []);
    const seen = pts.map(() => new Set());
    for (const el of elements) {
      const t = el.tags || {};
      const name = t.name;
      if (!name) continue;
      const elat = el.lat != null ? el.lat : (el.center && el.center.lat);
      const elon = el.lon != null ? el.lon : (el.center && el.center.lon);
      if (elat == null || elon == null) continue;
      // Assign the place to the nearest stop.
      let best = -1, bestD = Infinity;
      for (let i = 0; i < pts.length; i++) {
        const d = metersBetween(pts[i].lat, pts[i].lon, elat, elon);
        if (d < bestD) { bestD = d; best = i; }
      }
      if (best < 0 || bestD > R + 60) continue;
      const lc = name.trim().toLowerCase();
      if (seen[best].has(lc)) continue;
      seen[best].add(lc);
      buckets[best].push({ name: name.trim(), category: osmCategory(t), dist: Math.round(bestD) });
    }

    const nearby = buckets.map((arr, i) => ({
      point: i,
      name: pts[i].name,
      landmarks: arr.sort((a, b) => a.dist - b.dist).slice(0, 6),
    }));

    nearbyCache.set(key, { t: Date.now(), data: nearby });
    return res.json({ nearby });
  } catch (err) {
    console.error("bus-nearby error:", err.message);
    return res.json({ nearby: [] });
  }
});

// ============================================================
// GET /api/route?fromLat=..&fromLng=..&toLat=..&toLng=..
// → { distance: "460 km", duration: "7 hr 30 min", geometry: [[lon,lat], ...] }
// ============================================================
router.get("/route", async (req, res) => {
  try {
    const { fromLat, fromLng, toLat, toLng } = req.query;

    if (!fromLat || !fromLng || !toLat || !toLng) {
      return res
        .status(400)
        .json({ error: "fromLat, fromLng, toLat, toLng are required" });
    }

    const url =
      `https://router.project-osrm.org/route/v1/driving/` +
      `${fromLng},${fromLat};${toLng},${toLat}` +
      `?overview=full&geometries=geojson`;

    const r = await axios.get(url, {
      headers: { "User-Agent": UA },
      timeout: 12000,
    });

    if (r.data.code !== "Ok" || !r.data.routes?.length) {
      return res.status(404).json({ error: "No route found" });
    }

    const route = r.data.routes[0];

    // distance: meters → "X km"   (one decimal under 100 km)
    const km = route.distance / 1000;
    const distance = km >= 100 ? `${Math.round(km)} km` : `${km.toFixed(1)} km`;

    // duration: seconds → "X hr Y min"  or  "Y min"
    const totalMin = Math.round(route.duration / 60);
    const hr = Math.floor(totalMin / 60);
    const min = totalMin % 60;
    const duration = hr > 0 ? `${hr} hr ${min} min` : `${min} min`;

    return res.json({
      distance,
      duration,
      geometry: route.geometry.coordinates, // [[lon, lat], ...]
    });
  } catch (err) {
    console.error("route error:", err.message);
    const status = err.response?.status || 500;
    return res
      .status(status)
      .json({ error: err.response?.data?.error || "Route lookup failed" });
  }
});

module.exports = router;
