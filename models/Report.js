const mongoose = require("mongoose");

/**
 * Report — one row per submitted report.
 * Moderators review reports filtered by status="pending".
 */
const reportSchema = new mongoose.Schema(
  {
    reporterPhone: { type: String, required: true, index: true },
    reportedPhone: { type: String, required: true, index: true },
    reason: {
      type: String,
      enum: ["Spam", "Fake profile", "Inappropriate behavior", "Safety concern", "Other"],
      required: true,
    },
    details: { type: String, default: "", maxlength: 1000 },
    status: {
      type: String,
      enum: ["pending", "reviewing", "resolved", "dismissed"],
      default: "pending",
      index: true,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Report", reportSchema);
