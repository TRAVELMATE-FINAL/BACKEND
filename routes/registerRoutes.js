// routes/registerRoutes.js
const express = require("express");
const router = express.Router();

const {
  sendOtp,
  verifyOtp,
  saveProfile,
  getProfile,
} = require("../controllers/registerController"); // ✅ NOT userController

// OTP
router.post("/send-otp", sendOtp);
router.post("/verify-otp", verifyOtp);

// Profile
router.post("/profile", saveProfile);

router.get("/profile", getProfile); // ✅ ADD THIS

module.exports = router; 