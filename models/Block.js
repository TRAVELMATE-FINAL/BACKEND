const mongoose = require("mongoose");

/**
 * Block — one row per (blocker → blocked) pair.
 * Compound unique index prevents duplicates.
 */
const blockSchema = new mongoose.Schema(
  {
    blockerPhone: { type: String, required: true, index: true },
    blockedPhone: { type: String, required: true, index: true },
    blockedName:  { type: String, default: "" },
    blockedPhoto: { type: String, default: "" },
  },
  { timestamps: true }
);

blockSchema.index({ blockerPhone: 1, blockedPhone: 1 }, { unique: true });

module.exports = mongoose.model("Block", blockSchema);
