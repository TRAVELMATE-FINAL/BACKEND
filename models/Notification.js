const mongoose = require("mongoose");

/**
 * Notification — items shown on the user's Notifications page.
 *
 * `userPhone` is the recipient. Notifications are auto-generated when:
 *   • a ride the user posted is successfully published (type: "ride")
 *   • a payment for a plan succeeds                   (type: "payment")
 *   • the system needs to warn the user               (type: "warning")
 *   • generic info                                    (type: "info")
 *
 * The frontend reads `type`, `title`, `body`, `read`, `createdAt`, and
 * optionally `action.to` (a frontend route to navigate to when clicked).
 */
const notificationSchema = new mongoose.Schema(
  {
    userPhone: {
      type: String,
      required: true,
      index: true,
    },
    type: {
      type: String,
      enum: ["ride", "payment", "warning", "info"],
      default: "info",
    },
    title: { type: String, default: "" },
    body: { type: String, default: "" },
    read: { type: Boolean, default: false, index: true },
    action: {
      to: { type: String, default: "" }, // frontend route, e.g. "/ride-detail?rideId=..."
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Notification", notificationSchema);
