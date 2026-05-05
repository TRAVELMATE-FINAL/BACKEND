// controllers/rideController.js
// Business logic for PostRide and FindRide / FindFriends pages (CommonJS)

const Ride = require("../models/Ride");

// ---------- helpers ----------
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

// @desc   Post a new ride
// @route  POST /api/rides
const createRide = async (req, res) => {
  try {
    const {
      from, to, date, time, gender, distance, duration,
      fromLat, fromLon, toLat, toLon,
    } = req.body;

    // 1. Required fields
    if (!from || !to || !date || !time || !gender || !distance || !duration) {
      return res.status(400).json({
        success: false,
        error: "All fields are required: from, to, date, time, gender, distance, duration",
        message: "All fields are required: from, to, date, time, gender, distance, duration",
      });
    }
    // 2. From / To cannot be the same
    if (from.trim().toLowerCase() === to.trim().toLowerCase()) {
      return res.status(400).json({
        success: false,
        error: "'From' and 'To' cannot be the same location",
        message: "'From' and 'To' cannot be the same location",
      });
    }
    // 3. Date cannot be in the past
    if (date < todayStr()) {
      return res.status(400).json({
        success: false,
        error: "Date cannot be in the past — rides must start from today onwards",
        message: "Date cannot be in the past — rides must start from today onwards",
      });
    }
    // 4. If date is today, time must be in the future
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
};

// @desc   Get all rides (newest first) — for FindFriends page
// @route  GET /api/rides
const getAllRides = async (req, res) => {
  try {
    const rides = await Ride.find().sort({ createdAt: -1 });
    return res.status(200).json({ success: true, count: rides.length, data: rides });
  } catch (err) {
    console.error("getAllRides error:", err);
    return res.status(500).json({
      success: false,
      error: "Server error while fetching rides. Please try again.",
      message: "Server error while fetching rides. Please try again.",
    });
  }
};

// @desc   Search rides by from + to (FindRide → FindFriends)
// @route  GET /api/rides/search?from=Chennai&to=Madurai
const searchRides = async (req, res) => {
  try {
    const { from, to } = req.query;
    if (!from || !to) {
      return res.status(400).json({
        success: false,
        error: "Both 'from' and 'to' query params are required",
        message: "Both 'from' and 'to' query params are required",
      });
    }

    const rides = await Ride.find({
      from: { $regex: `^${from.trim()}$`, $options: "i" },
      to:   { $regex: `^${to.trim()}$`,   $options: "i" },
    }).sort({ createdAt: -1 });

    if (rides.length === 0) {
      return res.status(200).json({
        success: true,
        count: 0,
        message: "Ride not available",
        data: [],
      });
    }

    return res.status(200).json({ success: true, count: rides.length, data: rides });
  } catch (err) {
    console.error("searchRides error:", err);
    return res.status(500).json({
      success: false,
      error: "Server error while searching rides. Please try again.",
      message: "Server error while searching rides. Please try again.",
    });
  }
};

module.exports = { createRide, getAllRides, searchRides };
