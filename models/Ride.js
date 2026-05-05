// models/Ride.js
// Mongoose schema for a TravelMate ride post (CommonJS)

const mongoose = require("mongoose");

const rideSchema = new mongoose.Schema(
  {
    from: {
      type: String,
      required: [true, "Starting location (from) is required"],
      trim: true,
    },
    to: {
      type: String,
      required: [true, "Destination (to) is required"],
      trim: true,
    },
    date: {
      // YYYY-MM-DD string from <input type="date" />
      type: String,
      required: [true, "Date is required"],
      trim: true,
    },
    time: {
      // HH:MM (24h) string from <input type="time" />
      type: String,
      required: [true, "Time is required"],
      trim: true,
    },
    gender: {
      type: String,
      required: [true, "Gender preference is required"],
      enum: {
        values: ["Male", "Female", "Any", "male", "female", "any", ""],
        message: "Gender must be Male, Female, or Any",
      },
    },
    distance: { type: String, required: [true, "Distance is required"], trim: true },
    duration: { type: String, required: [true, "Duration is required"], trim: true },

    // Optional coordinates from PostRide.jsx (used to draw route on map)
    fromLat: { type: Number, default: null },
    fromLon: { type: Number, default: null },
    toLat:   { type: Number, default: null },
    toLon:   { type: Number, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Ride", rideSchema);
