// models/RideRequest.js
// A rider's request to join a specific posted ride. The ride owner accepts
// or rejects it; contact details are only revealed after acceptance.

const mongoose = require("mongoose");

const rideRequestSchema = new mongoose.Schema(
  {
    rideId:      { type: mongoose.Schema.Types.ObjectId, ref: "Ride", required: true, index: true },
    posterPhone: { type: String, required: true, trim: true, index: true }, // ride owner
    riderPhone:  { type: String, required: true, trim: true, index: true }, // requester

    // Snapshot of the requester's profile (so the owner sees who's asking).
    riderName:  { type: String, default: "" },
    riderPhoto: { type: String, default: "" },
    riderCity:  { type: String, default: "" },

    // Optional note from the rider.
    message: { type: String, default: "", maxlength: 300 },

    status: {
      type: String,
      enum: ["pending", "accepted", "rejected", "cancelled", "expired"],
      default: "pending",
      index: true,
    },
  },
  { timestamps: true }
);

// One active request per rider per ride (prevents duplicate requests).
rideRequestSchema.index({ rideId: 1, riderPhone: 1 }, { unique: true });

module.exports = mongoose.model("RideRequest", rideRequestSchema);
