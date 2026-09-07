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

    // Lifecycle. PAY-FIRST flow:
    //   awaiting_payment → (rider pays) → pending → accepted / rejected / expired
    // "awaiting_payment" is an internal holding state that owns the Razorpay
    // order; it is NEVER shown to the ride owner and never notified. The request
    // is only "sent" (visible to the owner) once payment succeeds → "pending".
    status: {
      type: String,
      enum: ["awaiting_payment", "pending", "accepted", "rejected", "cancelled", "expired"],
      default: "awaiting_payment",
      index: true,
    },

    // ── Payment (booking fee, charged BEFORE the request is sent) ────────
    // In the pay-first flow the rider pays up front; the request is created &
    // sent to the owner only after paymentStatus === "paid".
    paymentStatus: {
      type: String,
      enum: ["none", "pending", "paid", "failed", "refund_pending", "refunded", "refund_failed"],
      default: "none",
      index: true,
    },
    paymentOrderId: { type: String, default: "" }, // Razorpay order id (reused on retry)
    paymentId:      { type: String, default: "" }, // Razorpay payment id (set on success)
    amountDue:      { type: Number, default: 0 },   // rupees the rider must pay
    amountPaid:     { type: Number, default: 0 },   // rupees actually charged
    paidAt:         { type: Date,   default: null },

    // Owner must respond before this instant, else the request auto-expires and
    // the payment is refunded. Set when payment completes (status → pending).
    requestExpiresAt: { type: Date, default: null, index: true },

    // ── Refund (auto-refund to Razorpay on reject / expiry) ─────────────
    refundId:     { type: String, default: "" },   // Razorpay refund id
    refundAmount: { type: Number, default: 0 },     // rupees refunded
    refundedAt:   { type: Date,   default: null },
    refundReason: { type: String, default: "" },    // "rejected" | "expired" | ...
  },
  { timestamps: true }
);

// One request per rider per ride (prevents duplicate requests & payments).
rideRequestSchema.index({ rideId: 1, riderPhone: 1 }, { unique: true });

module.exports = mongoose.model("RideRequest", rideRequestSchema);
