// routes/rideRoutes.js
// All ride endpoints + handler logic in a single file (CommonJS).
// PostRide / FindFriends / Connect-Unlock APIs.

const express = require("express");
const router = express.Router();

const Ride = require("../models/Ride");
const User = require("../models/User");

// ============================================================
// HELPERS
// ============================================================

const todayStr = () => {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

const currentHHMM = () => {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

// "+919876543210" → "+91 98*****210"
const maskPhone = (phone) => {
  if (!phone) return "";
  const clean = String(phone).replace(/\s+/g, "");
  const cc = clean.startsWith("+") ? clean.slice(0, 3) : "";
  const digits = clean.slice(cc.length);
  if (digits.length < 5) return clean;
  const head = digits.slice(0, 2);
  const tail = digits.slice(-3);
  const stars = "*".repeat(digits.length - head.length - tail.length);
  return `${cc} ${head}${stars}${tail}`;
};

// Lenient User lookup — tolerates +91/91/bare 10 digits formats
const findUserByPhone = async (phone) => {
  if (!phone) return null;
  const raw = String(phone).trim();
  const last10 = raw.replace(/\D/g, "").slice(-10);

  const candidates = [raw];
  if (last10.length === 10) {
    candidates.push("+91" + last10, "91" + last10, last10);
  }

  for (const p of candidates) {
    const u = await User.findOne({ phone: p });
    if (u) return u;
  }
  if (last10.length === 10) {
    const u = await User.findOne({ phone: { $regex: last10 + "$" } });
    if (u) return u;
  }
  return null;
};

// ============================================================
// POST /api/rides — create a new ride
// ============================================================
router.post("/", async (req, res) => {
  try {
    const {
      from, to, date, time, gender, distance, duration,
      fromLat, fromLon, toLat, toLon,
      userPhone, vehicle, vehicleModel, vehicleColor, plateNumber,
      seatsAvailable, additionalInfo,
    } = req.body;

    if (!from || !to || !date || !time || !gender || !distance || !duration) {
      return res.status(400).json({
        success: false,
        error: "All fields are required: from, to, date, time, gender, distance, duration",
        message: "All fields are required: from, to, date, time, gender, distance, duration",
      });
    }
    if (from.trim().toLowerCase() === to.trim().toLowerCase()) {
      return res.status(400).json({
        success: false,
        error: "'From' and 'To' cannot be the same location",
        message: "'From' and 'To' cannot be the same location",
      });
    }
    if (date < todayStr()) {
      return res.status(400).json({
        success: false,
        error: "Date cannot be in the past — rides must start from today onwards",
        message: "Date cannot be in the past — rides must start from today onwards",
      });
    }
    if (date === todayStr() && time < currentHHMM()) {
      return res.status(400).json({
        success: false,
        error: "Time has already passed — please pick a future time",
        message: "Time has already passed — please pick a future time",
      });
    }

    const ride = await Ride.create({
      from: from.trim(),
      to: to.trim(),
      date,
      time,
      gender,
      distance,
      duration,
      fromLat: fromLat ?? null,
      fromLon: fromLon ?? null,
      toLat:   toLat   ?? null,
      toLon:   toLon   ?? null,
      userPhone: (userPhone || "").trim(),
      vehicle: vehicle || "Bike",
      vehicleModel: vehicleModel || "",
      vehicleColor: vehicleColor || "",
      plateNumber:  plateNumber  || "",
      seatsAvailable: typeof seatsAvailable === "number" ? seatsAvailable : 1,
      additionalInfo: additionalInfo || "",
    });

    return res.status(201).json({
      success: true,
      message: "Ride posted successfully",
      data: ride,
    });
  } catch (err) {
    if (err.name === "ValidationError") {
      const messages = Object.values(err.errors).map((e) => e.message);
      return res.status(400).json({ success: false, error: messages.join(", "), message: messages.join(", ") });
    }
    console.error("createRide error:", err);
    return res.status(500).json({
      success: false,
      error: "Server error while posting ride. Please try again.",
      message: "Server error while posting ride. Please try again.",
    });
  }
});

// ============================================================
// Helper — attach the poster's User profile (fullName + photo)
// to every ride so the FindFriends card can render real avatars.
// ============================================================
const enrichRidesWithUser = async (rides) => {
  const out = [];
  for (const r of rides) {
    const user = await findUserByPhone(r.userPhone);
    const obj = r.toObject ? r.toObject() : r;
    obj.driverName = user?.fullName?.trim() || "TravelMate Rider";
    obj.driverPhoto = user?.photo || "";
    obj.driverCity = user?.city || "";
    out.push(obj);
  }
  return out;
};

// ============================================================
// GET /api/rides — all rides, newest first (FindFriends)
// ============================================================
router.get("/", async (req, res) => {
  try {
    const rides = await Ride.find().sort({ createdAt: -1 });
    const enriched = await enrichRidesWithUser(rides);
    return res.status(200).json({ success: true, count: enriched.length, data: enriched });
  } catch (err) {
    console.error("getAllRides error:", err);
    return res.status(500).json({
      success: false,
      error: "Server error while fetching rides. Please try again.",
      message: "Server error while fetching rides. Please try again.",
    });
  }
});

// ============================================================
// GET /api/rides/search?from=&to=&date=&gender= — FindRide → FindFriends
//   • from / to   – partial, case-insensitive match (so "Chennai"
//                   also finds "Chennai Central")
//   • date        – optional, exact "YYYY-MM-DD" match
//   • gender      – optional, "Male" | "Female" | "Any"
// ============================================================
router.get("/search", async (req, res) => {
  try {
    const { from, to, date, gender } = req.query;
    if (!from || !to) {
      return res.status(400).json({
        success: false,
        error: "Both 'from' and 'to' query params are required",
        message: "Both 'from' and 'to' query params are required",
      });
    }

    // Escape regex special chars so city names like "Pondicherry (UT)"
    // don't break the query.
    const escapeRx = (s) =>
      String(s).trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    const query = {
      from: { $regex: escapeRx(from), $options: "i" },
      to:   { $regex: escapeRx(to),   $options: "i" },
    };

    // Exact date filter (YYYY-MM-DD) when provided
    if (date && String(date).trim()) {
      query.date = String(date).trim();
    }

    // Optional gender filter — case-insensitive equality
    if (gender && String(gender).trim()) {
      query.gender = { $regex: `^${escapeRx(gender)}$`, $options: "i" };
    }

    const rides = await Ride.find(query).sort({ createdAt: -1 });

    if (rides.length === 0) {
      return res.status(200).json({
        success: true,
        count: 0,
        message: "Ride not available",
        data: [],
      });
    }

    const enriched = await enrichRidesWithUser(rides);
    return res.status(200).json({ success: true, count: enriched.length, data: enriched });
  } catch (err) {
    console.error("searchRides error:", err);
    return res.status(500).json({
      success: false,
      error: "Server error while searching rides. Please try again.",
      message: "Server error while searching rides. Please try again.",
    });
  }
});

// ============================================================
// GET /api/rides/:id/connect — driver name + masked phone
// ============================================================
router.get("/:id/connect", async (req, res) => {
  try {
    const { id } = req.params;

    const ride = await Ride.findById(id);
    if (!ride) {
      return res.status(404).json({
        success: false,
        error: "Ride not found",
        message: "Ride not found",
      });
    }

    Ride.updateOne({ _id: id }, { $inc: { viewCount: 1 } }).catch(() => {});

    const user = await findUserByPhone(ride.userPhone);

    console.log(
      `[connect] rideId=${id} userPhone="${ride.userPhone}" → user=${user?.fullName || "(not found)"}`
    );

    const driverName = user?.fullName?.trim() || "TravelMate Rider";
    const driverPhone = ride.userPhone || "";

    return res.status(200).json({
      success: true,
      data: {
        ride: {
          _id: ride._id,
          from: ride.from,
          to: ride.to,
          date: ride.date,
          time: ride.time,
          gender: ride.gender,
          distance: ride.distance,
          duration: ride.duration,
          fromLat: ride.fromLat,
          fromLon: ride.fromLon,
          toLat: ride.toLat,
          toLon: ride.toLon,
          vehicle: ride.vehicle || "Bike",
          vehicleModel: ride.vehicleModel || "",
          vehicleColor: ride.vehicleColor || "",
          plateNumber: ride.plateNumber || "",
          seatsAvailable: typeof ride.seatsAvailable === "number" ? ride.seatsAvailable : 1,
          additionalInfo: ride.additionalInfo || "",
          viewCount: (ride.viewCount || 0) + 1,
          createdAt: ride.createdAt,
        },
        user: {
          fullName: driverName,
          photo: user?.photo || "",
          city: user?.city || "",
          maskedPhone: maskPhone(driverPhone),
        },
      },
    });
  } catch (err) {
    if (err.name === "CastError") {
      return res.status(400).json({
        success: false,
        error: "Invalid ride id",
        message: "Invalid ride id",
      });
    }
    console.error("getRideConnect error:", err);
    return res.status(500).json({
      success: false,
      error: "Server error while loading connect page",
      message: "Server error while loading connect page",
    });
  }
});

// ============================================================
// POST /api/rides/:id/unlock — reveal full driver phone
// ============================================================
router.post("/:id/unlock", async (req, res) => {
  try {
    const { id } = req.params;

    const ride = await Ride.findById(id);
    if (!ride) {
      return res.status(404).json({
        success: false,
        error: "Ride not found",
        message: "Ride not found",
      });
    }

    if (!ride.userPhone) {
      return res.status(404).json({
        success: false,
        error: "No contact info available for this ride",
        message: "No contact info available for this ride",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Contact unlocked",
      data: { phone: ride.userPhone },
    });
  } catch (err) {
    if (err.name === "CastError") {
      return res.status(400).json({
        success: false,
        error: "Invalid ride ID",
        message: "Invalid ride ID",
      });
    }
    return res.status(500).json({
      success: false,
      error: err.message || "Internal server error",
      message: err.message || "Internal server error",
    });
  }
});

module.exports = router;
