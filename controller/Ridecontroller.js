// controllers/rideController.js
// Business logic for PostRide and FindRide

const Ride = require("../models/Ride");

// @desc    Post a new ride
// @route   POST /api/rides
const createRide = async (req, res) => {
  try {
    const { from, to, date, time, gender, distance, duration } = req.body;

    // Validate all fields are present
    if (!from || !to || !date || !time || !gender || !distance || !duration) {
      return res.status(400).json({
        success: false,
        message:
          "All fields are required: from, to, date, time, gender, distance, duration",
      });
    }

    const ride = await Ride.create({ from, to, date, time, gender, distance, duration });

    res.status(201).json({
      success: true,
      message: "Ride posted successfully ✅",
      data: ride,
    });
  } catch (err) {
    // Mongoose validation error
    if (err.name === "ValidationError") {
      const messages = Object.values(err.errors).map((e) => e.message);
      return res.status(400).json({ success: false, message: messages.join(", ") });
    }

    console.error("❌ createRide error:", err);
    res.status(500).json({ success: false, message: "Server error. Please try again." });
  }
};

// @desc    Get all rides (newest first)
// @route   GET /api/rides
const getAllRides = async (req, res) => {
  try {
    const rides = await Ride.find().sort({ createdAt: -1 });

    res.status(200).json({
      success: true,
      count: rides.length,
      data: rides,
    });
  } catch (err) {
    console.error("❌ getAllRides error:", err);
    res.status(500).json({ success: false, message: "Server error. Please try again." });
  }
};

module.exports = { createRide, getAllRides };
