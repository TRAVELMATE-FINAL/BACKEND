// routes/registerRoutes.js
const express = require("express");
const router = express.Router();
const twilio = require("twilio");
const crypto = require("crypto");

const User = require("../models/User");
const { setOtp, verifyOtp: checkOtp } = require("../utils/otpStore");

// ── Password hashing (Node's built-in scrypt — no extra dependency) ──
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(pw), salt, 64).toString("hex");
  return `${salt}:${hash}`;
}
function verifyPassword(pw, stored) {
  if (!stored || !stored.includes(":")) return false;
  const [salt, hash] = stored.split(":");
  const test = crypto.scryptSync(String(pw), salt, 64).toString("hex");
  const a = Buffer.from(hash, "hex");
  const b = Buffer.from(test, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const isValidPassword = (pw) => typeof pw === "string" && pw.length >= 6;

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

    const messageText = `Dear User, your Vooggly OTP is ${otp}. It is valid for 1 minute. Do not share it.`;

    console.log("MESSAGE BODY:", messageText);

    // Sanitize the From number: Twilio's console shows it formatted with
    // spaces (e.g. "+1 828 492 2880"), and pasting that stores spaces which
    // Twilio rejects. Strip everything except digits and a leading "+".
    const fromNumber = String(process.env.TWILIO_PHONE || "").replace(/[^\d+]/g, "");

    const message = await client.messages.create({
      body: messageText,
      from: fromNumber,
      to: fullPhone,
    });

    console.log("✅ SMS SID:", message.sid);
    console.log("🔑 OTP (debug):", otp);

    await setOtp(fullPhone, otp);

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
    const { phone, otp, password } = req.body;

    if (!phone || !otp) {
      return res.status(400).json({ message: "Phone and OTP required" });
    }
    // OTP is the gate for setting a password (registration, recovery, or an
    // existing user setting one for the first time). If a password is sent it
    // must be valid.
    if (password !== undefined && !isValidPassword(password)) {
      return res.status(400).json({ message: "Password must be at least 6 characters" });
    }

    const cleanPhone = phone.replace("+91", "");
    const fullPhone = `+91${cleanPhone}`;

    const isValid = await checkOtp(fullPhone, otp);

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

    // If a password was provided (registration / forgot-password / first-time
    // set after OTP login), store it now — OTP just proved ownership.
    if (password !== undefined) {
      user.passwordHash = hashPassword(password);
      await user.save();
    }

    const safe = user.toObject ? user.toObject() : user;
    if (safe && safe.passwordHash) delete safe.passwordHash;

    return res.json({
      message: "Verified successfully",
      user: safe,
      hasPassword: !!user.passwordHash,
    });
  } catch (err) {
    console.error("❌ VERIFY OTP ERROR:", err);
    return res.status(500).json({
      message: err.message || "Verification failed",
    });
  }
});

// ======================
// PASSWORD LOGIN (no OTP)
// POST /login  { phone, password }
// ======================
router.post("/login", async (req, res) => {
  try {
    const { phone, password } = req.body || {};
    if (!phone) return res.status(400).json({ message: "Phone number is required" });

    const cleanPhone = String(phone).replace("+91", "");
    if (!/^\d{10}$/.test(cleanPhone)) {
      return res.status(400).json({ message: "Phone number must be exactly 10 digits" });
    }
    const fullPhone = `+91${cleanPhone}`;

    // passwordHash is select:false — request it explicitly for the check.
    const user = await User.findOne({ phone: fullPhone }).select("+passwordHash");
    if (!user) {
      return res.status(404).json({ message: "No account found for this number. Please register.", code: "NO_ACCOUNT" });
    }
    if (user.isBlocked) {
      return res.status(403).json({
        message: user.blockReason
          ? `Your account has been blocked: ${user.blockReason}`
          : "Your account has been blocked. Please contact support.",
        blocked: true,
      });
    }
    // Legacy user with no password yet → tell the client to verify via OTP and
    // set one (the "set password on next OTP login" path).
    if (!user.passwordHash) {
      return res.status(200).json({ needsPassword: true, message: "Please verify via OTP to set your password." });
    }
    if (!password) return res.status(400).json({ message: "Password is required" });
    if (!verifyPassword(password, user.passwordHash)) {
      return res.status(401).json({ message: "Incorrect phone number or password." });
    }

    const safe = user.toObject();
    delete safe.passwordHash;
    return res.json({ message: "Login successful", user: safe });
  } catch (err) {
    console.error("❌ LOGIN ERROR:", err);
    return res.status(500).json({ message: err.message || "Login failed" });
  }
});

// ======================
// ACCOUNT STATUS (no OTP, no SMS)
// GET /account-status?phone=XXXXXXXXXX
// Lets the client know, before the "Create a new account" OTP is sent,
// whether the number already belongs to an account — so an existing user
// is told to sign in instead of silently resetting their password.
// ======================
router.get("/account-status", async (req, res) => {
  try {
    const raw = String(req.query.phone || "");
    const cleanPhone = raw.replace("+91", "").replace(/\D/g, "");
    if (!/^\d{10}$/.test(cleanPhone)) {
      return res.status(400).json({ message: "Phone number must be exactly 10 digits" });
    }
    const fullPhone = `+91${cleanPhone}`;
    const user = await User.findOne({ phone: fullPhone }).select("+passwordHash");
    return res.json({
      exists: !!user,
      hasPassword: !!(user && user.passwordHash),
      blocked: !!(user && user.isBlocked),
    });
  } catch (err) {
    console.error("❌ ACCOUNT STATUS ERROR:", err);
    return res.status(500).json({ message: err.message || "Could not check account" });
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

// ======================
// DIAGNOSTIC: which Twilio config did the RUNNING server load?
// GET /api/auth/twilio-status
// Safe: SID is masked, auth token is never returned.
// ======================
router.get("/twilio-status", (req, res) => {
  const sid = process.env.TWILIO_SID || "";
  const tok = process.env.TWILIO_AUTH_TOKEN || "";
  res.json({
    sidPrefix: sid ? sid.slice(0, 6) : "(empty)",
    sidLength: sid.length,
    hasAuthToken: !!tok,
    authTokenLength: tok.length,
    // First 4 + last 4 chars so you can tell WHICH token is loaded.
    // Correct Live token -> "c672...f59a".  API-key secret -> "fGCm...QIw5".
    authTokenFingerprint: tok ? tok.slice(0, 4) + "..." + tok.slice(-4) : "(empty)",
    fromPhoneRaw: process.env.TWILIO_PHONE || "(empty)",
    fromPhoneUsed: String(process.env.TWILIO_PHONE || "").replace(/[^\d+]/g, "") || "(empty)",
  });
});

module.exports = router;