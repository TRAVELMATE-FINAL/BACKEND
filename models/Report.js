const mongoose = require("mongoose");

/**
 * Report - one row per submitted report.
 *
 * NOTE: This schema is shared with the standalone admin backend
 * (travel-admin/backend/models/Report.js) - both map to the SAME
 * "reports" collection in the Tesco database. Keep the two in sync.
 *
 * `description` is the canonical free-text field the admin panel reads.
 * `details` is kept as a legacy mirror so older client builds keep working.
 */
const reportSchema = new mongoose.Schema(
  {
    reporterPhone: { type: String, required: true, trim: true, index: true },
    reporterName:  { type: String, default: "", trim: true },
    reportedPhone: { type: String, required: true, trim: true, index: true },
    reportedName:  { type: String, default: "", trim: true },
    rideId:        { type: mongoose.Schema.Types.ObjectId, ref: "Ride", default: null },

    // Free-text reason (e.g. "Spam", "Safety concern", or an admin-entered reason)
    reason:        { type: String, required: true, trim: true },

    // Canonical body text read by the admin panel
    description:   { type: String, default: "", maxlength: 1000 },
    // Legacy mirror of `description` for older client builds
    details:       { type: String, default: "", maxlength: 1000 },

    // Superset of both apps' statuses so neither side fails validation
    status: {
      type: String,
      enum: ["pending", "reviewing", "resolved", "actioned", "dismissed"],
      default: "pending",
      index: true,
    },
    adminNote:     { type: String, default: "" },
    reviewedAt:    { type: Date, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Report", reportSchema);
