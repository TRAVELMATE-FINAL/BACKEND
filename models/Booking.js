// models/Booking.js - "bookings" collection. Who booked / who rode.
//
// NOTE: This schema is shared with the standalone admin backend
// (travel-admin/backend/models/Booking.js) - both map to the SAME
// "bookings" collection in the Tesco database. Keep the two in sync.
//
// A Booking row is created when a rider unlocks a ride's contact in the
// customer app, so the admin Bookings page and ride booked-counts reflect
// real TravelMate activity.
const mongoose = require("mongoose");

const bookingSchema = new mongoose.Schema(
  {
    rideId: { type: mongoose.Schema.Types.ObjectId, ref: "Ride", required: true, index: true },
    from: { type: String, default: "" },
    to:   { type: String, default: "" },
    date: { type: String, default: "" },
    time: { type: String, default: "" },
    posterPhone: { type: String, default: "", trim: true },
    posterName:  { type: String, default: "", trim: true },
    riderPhone:  { type: String, required: true, trim: true },
    riderName:   { type: String, default: "", trim: true },
    status: { type: String, enum: ["booked", "completed", "cancelled"], default: "booked", index: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Booking", bookingSchema);
