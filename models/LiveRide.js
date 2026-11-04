// models/LiveRide.js
// Live Ride Sharing (CommonJS) — a standalone module, separate from posted
// rides / bookings. One passenger (the host) starts a live trip and shares the
// vehicle's GPS location; other verified members discover it, pay for a seat,
// and follow the same vehicle live.

const mongoose = require("mongoose");

const passengerSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    phone: { type: String, required: true, trim: true },
    name: { type: String, default: "" },
    photo: { type: String, default: "" },
    isHost: { type: Boolean, default: false },
    status: { type: String, enum: ["pending", "confirmed", "refunded"], default: "pending" },
    amountPaid: { type: Number, default: 0 },
    paymentOrderId: { type: String, default: "" },
    paymentId: { type: String, default: "" },
    refundId: { type: String, default: "" },
    joinedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const liveRideSchema = new mongoose.Schema(
  {
    hostId: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },
    hostPhone: { type: String, required: true, trim: true, index: true },
    hostName: { type: String, default: "" },
    rideId: { type: mongoose.Schema.Types.ObjectId, ref: "Ride", index: true },

    vehicle: {
      type: { type: String, default: "Car", trim: true }, // Car / Bike
      model: { type: String, default: "", trim: true },
      color: { type: String, default: "", trim: true },
      plate: { type: String, default: "", trim: true },
    },

    from: { type: String, required: true, trim: true },
    to: { type: String, required: true, trim: true },
    departureTime: { type: String, default: "", trim: true },

    totalSeats: { type: Number, required: true, min: 1, max: 20 },
    farePerSeat: { type: Number, required: true, min: 0 },

    status: { type: String, enum: ["live", "ended", "completed", "cancelled"], default: "live", index: true },

    // Latest GPS position pushed by the host device.
    currentLat: { type: Number, default: null },
    currentLon: { type: Number, default: null },
    destLat: { type: Number, default: null },
    destLon: { type: Number, default: null },
    lastLocationAt: { type: Date, default: null },

    startedAt: { type: Date, default: Date.now },
    endedAt: { type: Date, default: null },

    passengers: { type: [passengerSchema], default: [] },
  },
  { timestamps: true }
);

// Helper: confirmed seats (host + paid riders).
liveRideSchema.methods.confirmedCount = function () {
  return (this.passengers || []).filter((p) => p.status === "confirmed").length;
};

module.exports = mongoose.models.LiveRide || mongoose.model("LiveRide", liveRideSchema);
