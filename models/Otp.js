const mongoose = require("mongoose");

// OTPs are stored in MongoDB (not in-memory) so they survive server
// restarts and work across multiple app instances/workers. Each doc
// auto-deletes at `expiresAt` via a TTL index (expireAfterSeconds: 0).
const otpSchema = new mongoose.Schema(
  {
    phone: {
      type: String,
      required: true,
      index: true,
    },
    otp: {
      type: String,
      required: true,
    },
    expiresAt: {
      type: Date,
      required: true,
    },
  },
  { timestamps: true }
);

// TTL index: Mongo removes the document once the current time passes expiresAt.
otpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model("Otp", otpSchema);
