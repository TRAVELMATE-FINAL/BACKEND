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
      type: String,
      required: [true, "Date is required"],
      trim: true,
    },
    time: {
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

    // Coordinates from PostRide map
    fromLat: { type: Number, default: null },
    fromLon: { type: Number, default: null },
    toLat:   { type: Number, default: null },
    toLon:   { type: Number, default: null },

    // ── Connect/Unlock fields ─────────────────────────────────────
    // Phone of the user who posted this ride. Used to look up name/photo.
    userPhone: { type: String, default: "", trim: true },

    // Vehicle info shown on Connect page (Figma)
    vehicle:      { type: String, default: "Bike", trim: true },     // "Car" | "Bike"
    vehicleModel: { type: String, default: "",     trim: true },     // e.g. "Swift"
    vehicleColor: { type: String, default: "",     trim: true },     // e.g. "White"
    plateNumber:  { type: String, default: "",     trim: true },     // e.g. "TN09 AB1234"
    seatsAvailable: { type: Number, default: 1, min: 0 },            // pillion/seats free

    additionalInfo: { type: String, default: "", maxlength: 500 },

    // # of times someone opened the connect page for this ride
    viewCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Ride", rideSchema);
