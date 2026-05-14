// routes/notificationRoutes.js
//
// Endpoints:
//   GET    /api/notifications?phone=+91...   — list user's notifications (newest first)
//   PATCH  /api/notifications/:id/read       — mark one as read
//   POST   /api/notifications                — create one (used internally; safe to expose)
//   DELETE /api/notifications/:id            — remove one

const express = require("express");
const router = express.Router();
const Notification = require("../models/Notification");

/* Normalize +91-prefixed Indian numbers the same way the rest of the
   codebase does. Other countries pass through unchanged. */
function normalizePhone(raw) {
  if (!raw) return "";
  const clean = String(raw).trim();
  if (/^\+\d{10,15}$/.test(clean)) return clean;
  const justDigits = clean.replace(/\D/g, "");
  if (justDigits.length === 10) return "+91" + justDigits;
  if (justDigits.length === 12 && justDigits.startsWith("91")) return "+" + justDigits;
  return clean;
}

// GET /api/notifications?phone=...
router.get("/", async (req, res) => {
  try {
    const phone = normalizePhone(req.query.phone || "");
    if (!phone) {
      return res.status(400).json({
        success: false,
        message: "phone query parameter is required",
      });
    }

    const items = await Notification.find({ userPhone: phone })
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();

    return res.json({ success: true, data: items });
  } catch (err) {
    console.error("❌ GET /api/notifications error:", err);
    return res.status(500).json({
      success: false,
      message: err.message || "Failed to load notifications",
    });
  }
});

// PATCH /api/notifications/:id/read
router.patch("/:id/read", async (req, res) => {
  try {
    const updated = await Notification.findByIdAndUpdate(
      req.params.id,
      { $set: { read: true } },
      { new: true }
    );
    if (!updated) {
      return res.status(404).json({ success: false, message: "Notification not found" });
    }
    return res.json({ success: true, data: updated });
  } catch (err) {
    console.error("❌ PATCH /api/notifications/:id/read error:", err);
    return res.status(500).json({
      success: false,
      message: err.message || "Failed to mark notification as read",
    });
  }
});

// POST /api/notifications
// body: { userPhone, type, title, body, action: { to } }
router.post("/", async (req, res) => {
  try {
    const { userPhone, type, title, body, action } = req.body || {};
    const phone = normalizePhone(userPhone);
    if (!phone) {
      return res.status(400).json({ success: false, message: "userPhone is required" });
    }
    const doc = await Notification.create({
      userPhone: phone,
      type: type || "info",
      title: title || "",
      body: body || "",
      action: action && action.to ? { to: action.to } : { to: "" },
    });
    return res.status(201).json({ success: true, data: doc });
  } catch (err) {
    console.error("❌ POST /api/notifications error:", err);
    return res.status(500).json({
      success: false,
      message: err.message || "Failed to create notification",
    });
  }
});

// DELETE /api/notifications/:id
router.delete("/:id", async (req, res) => {
  try {
    const deleted = await Notification.findByIdAndDelete(req.params.id);
    if (!deleted) {
      return res.status(404).json({ success: false, message: "Notification not found" });
    }
    return res.json({ success: true });
  } catch (err) {
    console.error("❌ DELETE /api/notifications/:id error:", err);
    return res.status(500).json({
      success: false,
      message: err.message || "Failed to delete notification",
    });
  }
});

module.exports = router;
