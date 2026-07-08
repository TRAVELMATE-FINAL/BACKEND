// models/Setting.js
// Single pricing document (key: "pricing") shared by the customer app and the
// admin panel. The admin panel writes it; the customer app reads it at runtime
// so price changes take effect without a rebuild.

const mongoose = require("mongoose");

const settingSchema = new mongoose.Schema(
  {
    key: { type: String, unique: true, default: "pricing" },

    // Post-ride subscription plans
    plans: {
      daily:   { price: { type: Number, default: 30 },   durationDays: { type: Number, default: 1 } },
      monthly: { price: { type: Number, default: 650 },  durationDays: { type: Number, default: 30 } },
      yearly:  { price: { type: Number, default: 1200 }, durationDays: { type: Number, default: 365 } },
    },

    // Find-ride (Unlock Contact) fees
    findRide: {
      unlockFee:     { type: Number, default: 49 },
      processingFee: { type: Number, default: 1 },
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Setting", settingSchema);
