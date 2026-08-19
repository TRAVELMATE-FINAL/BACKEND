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

    // ── Payment (booking fee, charged AFTER the driver confirms) ────────
    // Kept independent of `status` so a CONFIRMED booking can still be
    // PENDING payment. Only meaningful once status === "accepted".
    paymentStatus: {
      type: String,
      enum: ["none", "pending", "paid", "failed"],
      default: "none",
      index: true,
    },
    paymentOrderId: { type: String, default: "" }, // Razorpay order id (reused on retry)
    paymentId:      { type: String, default: "" }, // Razorpay payment id (set on success)
    amountDue:      { type: Number, default: 0 },   // rupees the rider must pay
    amountPaid:     { type: Number, default: 0 },   // rupees actually charged
    paidAt:         { type: Date,   default: null },
  },
  { timestamps: true }
);

// One active request per rider per ride (prevents duplicate requests).
rideRequestSchema.index({ rideId: 1, riderPhone: 1 }, { unique: true });

module.exports = mongoose.model("RideRequest", rideRequestSchema);
