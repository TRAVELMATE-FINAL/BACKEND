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
