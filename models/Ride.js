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
    farePerSeat:    { type: Number, default: 0, min: 0 },            // ₹ each co-passenger pays per seat

    // Notes / preferences — completely OPTIONAL.
    additionalInfo: { type: String, default: "", maxlength: 500 },

    // Whether pets are allowed on this ride. Derived from the notes at post
    // time so the Find Ride "Pets Allowed" filter can match on a real boolean
    // instead of fragile display text. Older rides without this field are
    // back-derived from their notes when returned by the API.
    petAllowed: { type: Boolean, default: false },

    // Whether smoking is allowed. Derived from the notes at post time. A ride
    // that doesn't mention smoking is treated as No Smoking (false). Older
    // rides without this field are back-derived from their notes by the API.
    smokingAllowed: { type: Boolean, default: false },

    // Lifecycle status. "active" by default; becomes "expired" automatically
    // once the ride's date+time passes, or "closed" if the owner closes it.
    // Expired/closed rides are excluded from search and can't take requests.
    status: {
      type: String,
      enum: ["active", "expired", "closed"],
      default: "active",
      index: true,
    },

    // # of times someone opened the connect page for this ride
    viewCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

// ── Duplicate-ride protection (DB level) ──────────────────────────────
// A single user (userPhone) may only have ONE ACTIVE ride at a given
// date + time. The partial filter means CLOSED / EXPIRED rides are ignored,
// so a user can re-post at the same slot after cancelling/closing an old one,
// and different users can post at the same date+time. This also guards
// against a race where two simultaneous requests both pass the app-level
// pre-check: the second insert fails with a duplicate-key (E11000) error.
// NOTE: userPhone is always normalized to "+91XXXXXXXXXX" before insert, so
// the index key is consistent.
rideSchema.index(
  { userPhone: 1, date: 1, time: 1 },
  { unique: true, partialFilterExpression: { status: "active" } }
);

module.exports = mongoose.model("Ride", rideSchema);
