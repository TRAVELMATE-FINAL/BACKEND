// routes/userActionsRoutes.js
//
// Mounted at /api/users in server.js
//
// Endpoints:
//   POST   /api/users/block            { blockerPhone, blockedPhone } → blocks a user
//   DELETE /api/users/block/:phone     body: { blockerPhone }         → unblocks
//   GET    /api/users/blocked          ?phone=...                     → list users I've blocked
//   POST   /api/users/report           { reporterPhone, reportedPhone, reason, details }

const express = require("express");
const router = express.Router();
const Block = require("../models/Block");
const Report = require("../models/Report");
const User = require("../models/User");

/* Normalize Indian phone numbers to +91xxxxxxxxxx; other countries passthrough. */
function normalizePhone(raw) {
  if (!raw) return "";
  const clean = String(raw).trim();
  if (/^\+\d{10,15}$/.test(clean)) return clean;
  const justDigits = clean.replace(/\D/g, "");
  if (justDigits.length === 10) return "+91" + justDigits;
  if (justDigits.length === 12 && justDigits.startsWith("91")) return "+" + justDigits;
  return clean;
}

// ── POST /api/users/block ─────────────────────────────────────────
router.post("/block", async (req, res) => {
  try {
    const blockerPhone = normalizePhone(req.body.blockerPhone);
    const blockedPhone = normalizePhone(req.body.blockedPhone);

    if (!blockerPhone || !blockedPhone) {
      return res.status(400).json({
        success: false,
        message: "blockerPhone and blockedPhone are both required",
      });
    }
    if (blockerPhone === blockedPhone) {
      return res.status(400).json({
        success: false,
        message: "You can't block yourself",
      });
    }

    // Denormalize the blocked user's name + photo so the Profile page
    // can display them without an extra User lookup.
    const blockedUser = await User.findOne({ phone: blockedPhone }).lean();

    const block = await Block.findOneAndUpdate(
      { blockerPhone, blockedPhone },
      {
        $set: {
          blockerPhone,
          blockedPhone,
          blockedName: blockedUser?.fullName || "",
          blockedPhoto: blockedUser?.photo || "",
        },
      },
      { upsert: true, new: true }
    );

    return res.status(201).json({ success: true, data: block });
  } catch (err) {
    console.error("❌ POST /api/users/block error:", err);
    return res.status(500).json({
      success: false,
      message: err.message || "Failed to block user",
    });
  }
});

// ── DELETE /api/users/block/:phone ────────────────────────────────
router.delete("/block/:phone", async (req, res) => {
  try {
    const blockerPhone = normalizePhone(req.body.blockerPhone);
    const blockedPhone = normalizePhone(req.params.phone);

    if (!blockerPhone || !blockedPhone) {
      return res.status(400).json({
        success: false,
        message: "blockerPhone (body) and phone (param) are required",
      });
    }

    const deleted = await Block.findOneAndDelete({ blockerPhone, blockedPhone });
    if (!deleted) {
      return res.status(404).json({
        success: false,
        message: "Block record not found",
      });
    }
    return res.json({ success: true });
  } catch (err) {
    console.error("❌ DELETE /api/users/block/:phone error:", err);
    return res.status(500).json({
      success: false,
      message: err.message || "Failed to unblock user",
    });
  }
});

// ── GET /api/users/blocked?phone=... ──────────────────────────────
router.get("/blocked", async (req, res) => {
  try {
    const blockerPhone = normalizePhone(req.query.phone || "");
    if (!blockerPhone) {
      return res.status(400).json({
        success: false,
        message: "phone query parameter is required",
      });
    }
    const items = await Block.find({ blockerPhone })
      .sort({ createdAt: -1 })
      .lean();
    return res.json({ success: true, data: items });
  } catch (err) {
    console.error("❌ GET /api/users/blocked error:", err);
    return res.status(500).json({
      success: false,
      message: err.message || "Failed to load blocked users",
    });
  }
});

// ── POST /api/users/report ────────────────────────────────────────
router.post("/report", async (req, res) => {
  try {
    const reporterPhone = normalizePhone(req.body.reporterPhone);
    const reportedPhone = normalizePhone(req.body.reportedPhone);
    const reason = String(req.body.reason || "").trim();
    const details = String(req.body.details || "").trim().slice(0, 1000);

    if (!reporterPhone || !reportedPhone) {
      return res.status(400).json({
        success: false,
        message: "reporterPhone and reportedPhone are both required",
      });
    }
    if (reporterPhone === reportedPhone) {
      return res.status(400).json({
        success: false,
        message: "You can't report yourself",
      });
    }
    const VALID = ["Spam", "Fake profile", "Inappropriate behavior", "Safety concern", "Other"];
    if (!VALID.includes(reason)) {
      return res.status(400).json({
        success: false,
        message: "Invalid reason. Must be one of: " + VALID.join(", "),
      });
    }

    // Denormalize names so the admin panel can show who reported whom
    // without extra lookups.
    const [reporterUser, reportedUser] = await Promise.all([
      User.findOne({ phone: reporterPhone }).lean(),
      User.findOne({ phone: reportedPhone }).lean(),
    ]);

    const report = await Report.create({
      reporterPhone,
      reporterName: reporterUser?.fullName || "",
      reportedPhone,
      reportedName: reportedUser?.fullName || "",
      reason,
      // Write both the canonical field (admin reads this) and the
      // legacy mirror so nothing depends on field-name drift.
      description: details,
      details,
    });

    return res.status(201).json({ success: true, data: { id: report._id } });
  } catch (err) {
    console.error("❌ POST /api/users/report error:", err);
    return res.status(500).json({
      success: false,
      message: err.message || "Failed to submit report",
    });
  }
});

module.exports = router;
