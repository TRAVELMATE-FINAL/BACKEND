// models/BusRoute.js
// Admin-managed bus route database (CommonJS). Routes are entered/verified by
// the admin team — the app never generates or assumes a route. Users look a
// route up by bus number.
//
// Shared collection ("busroutes") with the admin backend, which defines the
// same schema against the same MongoDB (dbName "Travelmate").

const mongoose = require("mongoose");

const stopSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    // Optional coordinates. If absent, the client geocodes the name for the map.
    lat: { type: Number, default: null },
    lon: { type: Number, default: null },
  },
  { _id: false }
);

const busRouteSchema = new mongoose.Schema(
  {
    // Display value exactly as entered, e.g. "TN 47 N", "138", "SETC 821".
    busNumber: { type: String, required: true, trim: true },
    // Normalized lookup key (uppercase, no spaces/hyphens) — unique.
    searchKey: { type: String, required: true, unique: true, index: true },

    operator: { type: String, default: "", trim: true }, // TNSTC / SETC / MTC …
    state: { type: String, default: "Tamil Nadu", trim: true },

    from: { type: String, required: true, trim: true }, // starting stop
    to:   { type: String, required: true, trim: true }, // final stop
    fromLat: { type: Number, default: null },
    fromLon: { type: Number, default: null },
    toLat:   { type: Number, default: null },
    toLon:   { type: Number, default: null },

    // Ordered intermediate stops (first → last), excluding from/to or including
    // them — the client renders from + stops + to in sequence regardless.
    stops: { type: [stopSchema], default: [] },

    notes:  { type: String, default: "", maxlength: 500 },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

// Build the normalized lookup key from the bus number before validating/saving.
busRouteSchema.pre("validate", function (next) {
  if (this.busNumber) {
    this.searchKey = String(this.busNumber).toUpperCase().replace(/[\s-]+/g, "");
  }
  next();
});

module.exports = mongoose.models.BusRoute || mongoose.model("BusRoute", busRouteSchema);
