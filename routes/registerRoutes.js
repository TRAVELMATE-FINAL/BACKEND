// routes/registerRoutes.js
const express = require("express");
const router = express.Router();
const twilio = require("twilio");

const User = require("../models/User");
const { setOtp, verifyOtp: checkOtp } = require("../utils/otpStore");

const client = twilio(
  process.env.TWILIO_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// ======================
// SEND OTP
// POST /send-otp
// ======================
router.post("/send-otp", async (req, res) => {
  try {
    const { phone } = req.body;

    if (!phone) {
      return res.status(400).json({ message: "Phone number is required" });
    }

    const cleanPhone = phone.replace("+91", "");

    if (!/^\d{10}$/.test(cleanPhone)) {
      return res.status(400).json({
        message: "Phone number must be exactly 10 digits",
      });
    }

    const fullPhone = `+91${cleanPhone}`;

    const otp = Math.floor(100000 + Math.random() * 900000).toString();

    const messageText = `Dear User, your TravelMate OTP is ${otp}. It is valid for 1 minute. Do not share it.`;

    console.log("MESSAGE BODY:", messageText);

    const message = await client.messages.create({
      body: messageText,
      from: process.env.TWILIO_PHONE,
      to: fullPhone,
    });

    console.log("✅ SMS SID:", message.sid);
    console.log("🔑 OTP (debug):", otp);

    setOtp(fullPhone, otp);

    return res.json({ message: "OTP sent successfully" });
  } catch (err) {
    console.error("❌ SEND OTP ERROR:", err);
    return res.status(500).json({
      message: err.message || "Failed to send OTP",
    });
  }
});

// ======================
// VERIFY OTP
// POST /verify-otp
// ======================
router.post("/verify-otp", async (req, res) => {
  try {
    const { phone, otp } = req.body;

    if (!phone || !otp) {
      return res.status(400).json({ message: "Phone and OTP required" });
    }

    const cleanPhone = phone.replace("+91", "");
    const fullPhone = `+91${cleanPhone}`;

    const isValid = checkOtp(fullPhone, otp);

    if (!isValid) {
      return res.status(400).json({ message: "Invalid or expired OTP" });
    }

    let user = await User.findOne({ phone: fullPhone });

    // Block enforcement — a user blocked from the admin panel cannot log in.
    if (user && user.isBlocked) {
      return res.status(403).json({
        message:
          user.blockReason
            ? `Your account has been blocked: ${user.blockReason}`
            : "Your account has been blocked. Please contact support.",
        blocked: true,
      });
    }

    if (!user) {
      user = await User.create({
        phone: fullPhone,
        isVerified: true,
      });
    } else {
      user.isVerified = true;
      await user.save();
    }

    return res.json({
      message: "Verified successfully",
      user,
    });
  } catch (err) {
    console.error("❌ VERIFY OTP ERROR:", err);
    return res.status(500).json({
      message: err.message || "Verification failed",
    });
  }
});

// ======================
// SAVE PROFILE
// POST /profile
// ======================
router.post("/profile", async (req, res) => {
  try {
    console.log("✅ /profile route HIT");
    console.log("REQ BODY:", req.body);

    const {
      phone,
      fullName,
      email,
      dob,
      city,
      about,
      gender,
      photo,
    } = req.body;

    // ── REQUIRED FIELDS ──────────────────────────────────────
    if (!phone || !fullName || !city) {
      return res.status(400).json({
        message: "Phone, Full Name and City are required",
      });
    }

    // ── NORMALIZE PHONE ──────────────────────────────────────
    const cleanPhone = phone.replace("+91", "");

    if (!/^\d{10}$/.test(cleanPhone)) {
      return res.status(400).json({
        message: "Phone must be exactly 10 digits",
      });
    }

    const fullPhone = `+91${cleanPhone}`;
    console.log("🔍 Looking for phone in DB:", fullPhone);

    // ── EMAIL VALIDATION ─────────────────────────────────────
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ message: "Invalid email format" });
    }

    // ── DOB VALIDATION ───────────────────────────────────────
    let parsedDob = null;

    if (dob) {
      const dobDate = new Date(dob);
      const today = new Date();

      if (isNaN(dobDate.getTime())) {
        return res.status(400).json({ message: "Invalid date of birth" });
      }

      if (dobDate > today) {
        return res.status(400).json({
          message: "Date of birth cannot be in the future",
        });
      }

      const thisYearBirthday = new Date(
        today.getFullYear(),
        dobDate.getMonth(),
        dobDate.getDate()
      );
      const age =
        today.getFullYear() -
        dobDate.getFullYear() -
        (today < thisYearBirthday ? 1 : 0);

      if (age < 13) {
        return res.status(400).json({
          message: "User must be at least 13 years old",
        });
      }

      parsedDob = dobDate;
    }

    // ── BIO VALIDATION ───────────────────────────────────────
    if (about && about.length > 300) {
      return res.status(400).json({
        message: "About/Bio must be under 300 characters",
      });
    }

    // ── ATOMIC UPSERT SAVE ───────────────────────────────────
    const updatedUser = await User.findOneAndUpdate(
      { phone: fullPhone },
      {
        $set: {
          fullName: fullName.trim(),
          email: email ? email.trim().toLowerCase() : "",
          dob: parsedDob,
          city: city.trim(),
          about: about ? about.trim() : "",
          gender: gender || "",
          photo: photo || "",
          isVerified: true,
        },
      },
      {
        new: true,
        upsert: true,
        runValidators: true,
      }
    );

    console.log("✅ Profile saved to MongoDB:", updatedUser);

    return res.status(200).json({
      message: "Profile saved successfully",
      user: updatedUser,
    });
  } catch (err) {
    console.error("❌ PROFILE SAVE ERROR:", err);

    if (err.name === "ValidationError") {
      const errors = Object.values(err.errors).map((e) => e.message);
      return res.status(400).json({
        message: "Validation failed",
        errors,
      });
    }

    return res.status(500).json({
      message: err.message || "Failed to save profile",
    });
  }
});

// ======================
// GET PROFILE
// GET /profile?phone=...
// ======================
router.get("/profile", async (req, res) => {
  try {
    const { phone } = req.query;

    if (!phone) {
      return res.status(400).json({
        message: "Phone is required",
      });
    }

    const cleanPhone = phone.replace("+91", "");

    if (!/^\d{10}$/.test(cleanPhone)) {
      return res.status(400).json({
        message: "Invalid phone number",
      });
    }

    const fullPhone = `+91${cleanPhone}`;

    console.log("🔍 Fetching profile for:", fullPhone);

    const user = await User.findOne({ phone: fullPhone });

    if (!user) {
      return res.status(404).json({
        message: "User not found",
      });
    }

    return res.status(200).json(user);
  } catch (err) {
    console.error("❌ GET PROFILE ERROR:", err);

    return res.status(500).json({
      message: err.message || "Failed to fetch profile",
    });
  }
});

module.exports = router;