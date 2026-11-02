// routes/busRouteRoutes.js
// Public read-only lookup of admin-managed bus routes. Mounted at /api/bus-routes.
// Separate from the ride-posting / booking workflows.

const express = require("express");
const router = express.Router();
const BusRoute = require("../models/BusRoute");

const normKey = (s) => String(s || "").toUpperCase().replace(/[\s-]+/g, "");

// GET /api/bus-routes/:number  → one route by bus number (case/space-insensitive)
router.get("/:number", async (req, res) => {
  try {
    const key = normKey(req.params.number);
    if (!key) {
      return res.status(400).json({ success: false, message: "Please enter a bus number." });
    }
    const route = await BusRoute.findOne({ searchKey: key, active: true }).lean();
    if (!route) {
      return res.status(404).json({
        success: false,
        code: "NOT_FOUND",
        message: `No route found for bus number "${req.params.number}". Please check the number and try again.`,
      });
    }
    return res.json({ success: true, data: route });
  } catch (err) {
    console.error("busRoute lookup error:", err.message);
    return res.status(500).json({ success: false, message: "Could not load the bus route. Please try again." });
  }
});

// GET /api/bus-routes?q=  → lightweight suggestions by partial bus number
// (optional helper for the search box; capped + only returns a few fields).
router.get("/", async (req, res) => {
  try {
    const q = normKey(req.query.q);
    if (!q || q.length < 1) return res.json({ success: true, data: [] });
    const rows = await BusRoute.find({ searchKey: { $regex: "^" + q }, active: true })
      .select("busNumber from to operator")
      .limit(8)
      .lean();
    return res.json({ success: true, data: rows });
  } catch (err) {
    return res.json({ success: true, data: [] });
  }
});

module.exports = router;
