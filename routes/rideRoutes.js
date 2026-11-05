// routes/rideRoutes.js
// All ride endpoints + handler logic in a single file (CommonJS).
// PostRide / FindFriends / Connect-Unlock APIs.

const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const mongoose = require("mongoose");

const Ride = require("../models/Ride");
const User = require("../models/User");
const Booking = require("../models/Booking");
const Notification = require("../models/Notification");
const RideRequest = require("../models/RideRequest");
const Subscription = require("../models/Subscription");
const LiveRide = require("../models/LiveRide");
const planCtrl = require("../controllers/planController");

// ============================================================
// HELPERS
// ============================================================

// ── Expiry helpers ──────────────────────────────────────────
// A ride is expired once its date+time has passed, OR it's been
// closed/completed/cancelled/expired explicitly. Enforced on the backend for search + direct
// access so old posts can never be returned or requested.
function rideDateTime(ride) {
  if (!ride || !ride.date) return null;
  const t = ride.time && /^\d{1,2}:\d{2}$/.test(ride.time) ? ride.time : "23:59";
  const dt = new Date(`${ride.date}T${t}:00`);
  return isNaN(dt.getTime()) ? null : dt;
}
function isRideExpired(ride) {
  if (!ride) return true;
  if (ride.status === "closed" || ride.status === "expired" || ride.status === "completed" || ride.status === "cancelled") return true;
  const dt = rideDateTime(ride);
  if (!dt) return false; // no parseable datetime → don't hide it
  return dt.getTime() < Date.now();
}
function rideStatusLabel(ride) {
  if (ride.status === "closed") return "closed";
  if (ride.status === "completed") return "completed";
  if (ride.status === "cancelled") return "cancelled";
  if (ride.status === "expired" || isRideExpired(ride)) return "expired";
  return "active";
}

// Vehicle name / model validation — must be a real name, not blank, numbers
// only, or symbols only. Allows real model names with digits (e.g. "Swift
// Dzire", "i20", "CB350"). Returns "" when valid, else an error message.
function validateVehicleName(raw) {
  const v = String(raw || "").trim();
  if (v.length < 2) return "Please enter a valid vehicle name";
  if (v.length > 40) return "Vehicle name is too long (max 40 characters)";
  if (!/^[A-Za-z0-9][A-Za-z0-9 .&'-]*$/.test(v)) return "Vehicle name can't contain special characters";
  const letters = (v.match(/[A-Za-z]/g) || []).length;
  if (letters < 2) return "Vehicle name must contain letters, not just numbers or symbols";
  if (/^(.)\1+$/.test(v.replace(/\s/g, ""))) return "Please enter a valid vehicle name";
  return "";
}

// Fire-and-forget notification creator.
async function notify(userPhone, title, body, to) {
  try {
    if (!userPhone) return;
    await Notification.create({
      userPhone,
      type: "info",
      title: title || "",
      body: body || "",
      action: { to: to || "" },
    });
  } catch (e) { /* non-fatal */ }
}

// ── SMS (Twilio) — fire-and-forget owner alert ──────────────────────────
// Reuses the same Twilio creds as the OTP flow. Never throws; SMS failure must
// not break the request flow (the in-app notification still fires).
let _twilioClient = null;
function getTwilio() {
  if (_twilioClient) return _twilioClient;
  try {
    if (!process.env.TWILIO_SID || !process.env.TWILIO_AUTH_TOKEN) return null;
    _twilioClient = require("twilio")(process.env.TWILIO_SID, process.env.TWILIO_AUTH_TOKEN);
    return _twilioClient;
  } catch { return null; }
}
async function sendSms(toPhone, body) {
  try {
    const client = getTwilio();
    const from = String(process.env.TWILIO_PHONE || "").replace(/[^\d+]/g, "");
    if (!client || !from || !toPhone) return;
    const to = normalizePhone(toPhone);
    await client.messages.create({ body, from, to });
  } catch (e) { /* non-fatal */ }
}

// ── Auto-refund a paid request to the original Razorpay payment ──────────
// Idempotent: only refunds a request whose paymentStatus is exactly "paid".
// On success → "refunded"; on API failure → "refund_pending" so it can be
// retried / handled manually from the admin panel. Never throws.
const REQUEST_TTL_MS = 60 * 60 * 1000; // owner has 1 hour to respond

async function refundRequestPayment(reqDoc, reason) {
  try {
    if (!reqDoc) return;
    if (reqDoc.paymentStatus !== "paid") return;          // nothing to refund / already handled
    if (!reqDoc.paymentId || !(reqDoc.amountPaid > 0)) {
      reqDoc.paymentStatus = "refund_pending";
      reqDoc.refundReason = reason || "";
      await reqDoc.save();
      return;
    }
    const client = planCtrl.getRazorpayClient();
    if (!client) {
      reqDoc.paymentStatus = "refund_pending";
      reqDoc.refundReason = reason || "";
      await reqDoc.save();
      return;
    }
    const refund = await client.payments.refund(reqDoc.paymentId, {
      amount: Math.round(reqDoc.amountPaid * 100), // paise
      speed: "normal",
      notes: { reason: reason || "", bookingId: String(reqDoc._id) },
    });
    reqDoc.paymentStatus = "refunded";
    reqDoc.refundId = refund?.id || "";
    reqDoc.refundAmount = reqDoc.amountPaid;
    reqDoc.refundedAt = new Date();
    reqDoc.refundReason = reason || "";
    await reqDoc.save();
  } catch (e) {
    try {
      reqDoc.paymentStatus = "refund_pending";
      reqDoc.refundReason = reason || "";
      await reqDoc.save();
    } catch (_e) {}
    console.error("refundRequestPayment error:", e?.message || e);
  }
}

// ── Sweep: auto-expire PAID+PENDING requests the owner didn't answer in time.
// Lazy sweep (no cron dependency) — invoked from request list/detail endpoints.
let _lastReqSweep = 0;
async function sweepExpiredRequests() {
  const now = Date.now();
  if (now - _lastReqSweep < 30000) return; // at most every 30s
  _lastReqSweep = now;
  try {
    const due = await RideRequest.find({
      status: "pending",
      requestExpiresAt: { $ne: null, $lt: new Date() },
    });
    for (const reqDoc of due) {
      reqDoc.status = "expired";
      await reqDoc.save();
      await refundRequestPayment(reqDoc, "expired");
      const ride = await Ride.findById(reqDoc.rideId).select("from to");
      notify(reqDoc.riderPhone, "Ride Request Expired",
        `The ride owner didn't respond in time${ride ? ` to your request from ${ride.from} to ${ride.to}` : ""}. Your payment has been refunded.`,
        "/requests?tab=sent");
    }
  } catch (e) { /* non-fatal */ }
}

// Strip ONLY contact info (phone numbers, emails) from the notes while keeping
// the rest of the poster's preferences intact and readable. The real
// preferences (e.g. "AC car, No smoking, Pet friendly") are shown as-is; any
// phone/email typed into the field is removed entirely (no visible marker) so
// contact is never leaked here — it's shared only after payment.
// Derive a pet-allowed boolean from free-text notes. True when pets are
// mentioned WITHOUT a negation ("pet friendly", "pets allowed", "pets welcome"),
// false for "no pets" / "pets not allowed" / no mention at all.
function derivePetAllowed(text) {
  const t = String(text || "").toLowerCase();
  if (!/\bpets?\b/.test(t)) return false;
  if (/\bno\s+pets?\b/.test(t)) return false;
  if (/pets?\s+(are\s+)?not\s+allowed/.test(t)) return false;
  if (/\bpets?\s+not\b/.test(t)) return false;
  return true;
}

// Derive a smoking-allowed boolean from free-text notes. True only when
// smoking is mentioned WITHOUT a negation ("smoking allowed", "smoker
// friendly"). "no smoking", "non-smoking", "smoking not allowed", or no
// mention at all → false (No Smoking).
function deriveSmokingAllowed(text) {
  const t = String(text || "").toLowerCase();
  if (!/\bsmok/.test(t)) return false;
  if (/\bno\s+smok/.test(t)) return false;
  if (/non[-\s]?smok/.test(t)) return false;
  if (/smoking\s+(is\s+)?not\s+allowed/.test(t)) return false;
  return true;
}

function sanitizeNotes(text) {
  if (!text) return "";
  let out = String(text);
  out = out.replace(/\+?\d[\d\s\-().]{7,}\d/g, " "); // remove phone-like numbers
  out = out.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, " "); // remove emails
  // Re-tidy into clean comma/newline-separated fragments, dropping any empties
  // left behind by the removal so there's no dangling punctuation.
  const parts = out
    .split(/[\n,]+/)
    .map((s) => s.replace(/\s{2,}/g, " ").trim())
    .filter(Boolean);
  return parts.join(", ");
}

// Throttled sweep: mark past-due active rides as expired and cascade their
// still-pending requests → expired (notifying the riders). Runs at most once
// per 60s so it doesn't add load to every request.
let _lastSweep = 0;
async function sweepExpiredRides() {
  const now = Date.now();
  if (now - _lastSweep < 60000) return;
  _lastSweep = now;
  try {
    const actives = await Ride.find({ status: "active" }).select("_id date time from to");
    for (const r of actives) {
      if (!isRideExpired(r)) continue;
      await Ride.updateOne({ _id: r._id }, { $set: { status: "expired" } });
      const pend = await RideRequest.find({ rideId: r._id, status: "pending" });
      for (const req of pend) {
        req.status = "expired";
        await req.save();
        // Pay-first: a pending request is already paid → refund it.
        await refundRequestPayment(req, "ride_expired");
        notify(req.riderPhone, "Ride Expired",
          `The ride from ${r.from} to ${r.to} has reached its scheduled time and is no longer available. Your request has been closed and your payment refunded.`, "/requests?tab=sent");
      }
    }
  } catch (e) { /* non-fatal */ }
}

const todayStr = () => {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

const currentHHMM = () => {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

// Normalize a phone string to the canonical "+91XXXXXXXXXX" form so
// rides + users use identical strings and look-ups always match.
const normalizePhone = (raw) => {
  const digits = String(raw || "").replace(/\D/g, "");
  if (digits.length === 0) return "";
  const last10 = digits.slice(-10);
  if (last10.length !== 10) return String(raw || "").trim();
  return "+91" + last10;
};

// All stored forms a phone might take (e.g. +91XXXXXXXXXX, 91XXXXXXXXXX, XXXXXXXXXX)
const phoneVariantsOf = (raw) => {
  const s = String(raw || "").trim();
  const last10 = s.replace(/\D/g, "").slice(-10);
  const list = s ? [s] : [];
  if (last10.length === 10) list.push("+91" + last10, "91" + last10, last10);
  return [...new Set(list)];
};

const samePhone = (a, b) =>
  phoneVariantsOf(a).some((v) => phoneVariantsOf(b).includes(v));

// "+919876543210" → "+91 98*****210"
const maskPhone = (phone) => {
  if (!phone) return "";
  const clean = String(phone).replace(/\s+/g, "");
  const cc = clean.startsWith("+") ? clean.slice(0, 3) : "";
  const digits = clean.slice(cc.length);
  if (digits.length < 5) return clean;
  const head = digits.slice(0, 2);
  const tail = digits.slice(-3);
  const stars = "*".repeat(digits.length - head.length - tail.length);
  return `${cc} ${head}${stars}${tail}`;
};

// Lenient User lookup — tolerates +91/91/bare 10 digits formats
const findUserByPhone = async (phone) => {
  if (!phone) return null;
  const raw = String(phone).trim();
  const last10 = raw.replace(/\D/g, "").slice(-10);

  const candidates = [raw];
  if (last10.length === 10) {
    candidates.push("+91" + last10, "91" + last10, last10);
  }

  for (const p of candidates) {
    const u = await User.findOne({ phone: p });
    if (u) return u;
  }
  if (last10.length === 10) {
    const u = await User.findOne({ phone: { $regex: last10 + "$" } });
    if (u) return u;
  }
  return null;
};

// Resolve user document by userId (ObjectId) or phone
const resolveUser = async ({ userId, phone }) => {
  if (userId && mongoose.Types.ObjectId.isValid(userId)) {
    const u = await User.findById(userId);
    if (u) return u;
  }
  if (phone) {
    return await findUserByPhone(phone);
  }
  return null;
};

// Check if a user currently has an active ride they created (as driver) OR an active ride they joined (as passenger).
// Validates using the user's ID as well as their phone number.
const getUserActiveRideStatus = async ({ userId, phone }) => {
  const user = await resolveUser({ userId, phone });
  const targetUserId = user?._id || (userId && mongoose.Types.ObjectId.isValid(userId) ? userId : null);
  const targetPhone = user?.phone || normalizePhone(phone);
  const variants = targetPhone ? phoneVariantsOf(targetPhone) : [];

  if (!targetUserId && !variants.length) {
    return { hasActiveCreatedRide: false, hasActiveJoinedRide: false, activeRide: null, activeType: null };
  }

  // 1. Check if user is creator of an active Ride
  const rideConditions = [];
  if (targetUserId) rideConditions.push({ userId: targetUserId });
  if (variants.length) rideConditions.push({ userPhone: { $in: variants } });

  const activeCreatedRides = await Ride.find({
    $or: rideConditions,
    status: "active",
  }).sort({ createdAt: -1 });

  for (const r of activeCreatedRides) {
    if (!isRideExpired(r)) {
      return {
        hasActiveCreatedRide: true,
        hasActiveJoinedRide: false,
        activeRide: r,
        activeRideId: r._id,
        activeType: "posted",
        isCreator: true,
        message: "You have already started a ride. You cannot join another ride until your current ride is completed or cancelled."
      };
    }
  }

  // 2. Check if user is host of an active LiveRide
  const liveConditions = [];
  if (targetUserId) liveConditions.push({ hostId: targetUserId });
  if (variants.length) liveConditions.push({ hostPhone: { $in: variants } });

  const activeLiveRides = await LiveRide.find({
    $or: liveConditions,
    status: "live",
  }).sort({ createdAt: -1 });

  if (activeLiveRides.length > 0) {
    return {
      hasActiveCreatedRide: true,
      hasActiveJoinedRide: false,
      activeRide: activeLiveRides[0],
      activeRideId: activeLiveRides[0]._id,
      activeType: "live",
      isCreator: true,
      message: "You have already started a ride. You cannot join another ride until your current ride is completed or cancelled."
    };
  }

  // 3. Check if user is an accepted passenger in an active Ride
  const requestConditions = [];
  if (targetUserId) requestConditions.push({ riderId: targetUserId });
  if (variants.length) requestConditions.push({ riderPhone: { $in: variants } });

  const joinedRequests = await RideRequest.find({
    $or: requestConditions,
    status: "accepted",
  }).populate("rideId");

  for (const req of joinedRequests) {
    const r = req.rideId;
    if (r && r.status === "active" && !isRideExpired(r)) {
      return {
        hasActiveCreatedRide: false,
        hasActiveJoinedRide: true,
        activeRide: r,
        activeRideId: r._id,
        activeType: "posted_passenger",
        isCreator: false,
        message: "You have already joined an active ride as a passenger."
      };
    }
  }

  // 4. Check if user is a confirmed passenger in an active LiveRide
  const joinedLiveRides = await LiveRide.find({
    status: "live",
    passengers: {
      $elemMatch: {
        ...(variants.length ? { phone: { $in: variants } } : {}),
        isHost: false,
        status: "confirmed",
      }
    }
  });

  if (joinedLiveRides.length > 0) {
    return {
      hasActiveCreatedRide: false,
      hasActiveJoinedRide: true,
      activeRide: joinedLiveRides[0],
      activeRideId: joinedLiveRides[0]._id,
      activeType: "live_passenger",
      isCreator: false,
      message: "You have already joined an active live ride as a passenger."
    };
  }

  return { hasActiveCreatedRide: false, hasActiveJoinedRide: false, activeRide: null, activeType: null };
};

// Auth gate for paid booking actions: the rider must be a real, verified,
// non-blocked account. On failure it sends the response and returns null.
const requireVerifiedRider = async (phone, res) => {
  const u = await findUserByPhone(phone);
  if (!u || !u.isVerified) {
    res.status(401).json({
      success: false,
      code: "AUTH_REQUIRED",
      message: "Please log in or create an account to make a payment.",
    });
    return null;
  }
  if (u.isBlocked) {
    res.status(403).json({
      success: false,
      blocked: true,
      message: u.blockReason
        ? `Your account has been blocked: ${u.blockReason}`
        : "Your account has been blocked. Please contact support.",
    });
    return null;
  }
  return u;
};

// ============================================================
// GET /api/rides/user-active-status — checks if user has active created/joined ride
// ============================================================
router.get("/user-active-status", async (req, res) => {
  try {
    const { userId, phone } = req.query;
    const status = await getUserActiveRideStatus({ userId, phone });
    return res.json({ success: true, ...status });
  } catch (err) {
    console.error("user-active-status error:", err);
    return res.status(500).json({ success: false, message: "Could not check user active status" });
  }
});

// ============================================================
// POST /api/rides — create a new ride
// ============================================================
router.post("/", async (req, res) => {
  try {
    const {
      from, to, date, time, gender, distance, duration,
      fromLat, fromLon, toLat, toLon,
      userPhone, vehicle, vehicleModel, vehicleColor, plateNumber,
      seatsAvailable, farePerSeat, additionalInfo, stops,
    } = req.body;

    // Normalize intermediate stops → [{ name, lat, lon }], dropping blanks.
    const cleanStops = Array.isArray(stops)
      ? stops
          .map((s) => (typeof s === "string" ? { name: s } : s))
          .map((s) => ({
            name: String(s?.name || "").trim(),
            lat: Number.isFinite(Number(s?.lat)) ? Number(s.lat) : null,
            lon: Number.isFinite(Number(s?.lon)) ? Number(s.lon) : null,
          }))
          .filter((s) => s.name)
      : [];

    if (!from || !to || !date || !time || !gender || !distance || !duration) {
      return res.status(400).json({
        success: false,
        error: "All fields are required: from, to, date, time, gender, distance, duration",
        message: "All fields are required: from, to, date, time, gender, distance, duration",
      });
    }
    if (from.trim().toLowerCase() === to.trim().toLowerCase()) {
      return res.status(400).json({
        success: false,
        error: "'From' and 'To' cannot be the same location",
        message: "'From' and 'To' cannot be the same location",
      });
    }
    // ── Vehicle name validation (server-side) — must be a real name, not
    // blank / numbers-only / symbols-only. Mirrors the client check so the
    // API can't be bypassed with junk. ──
    {
      const vmsg = validateVehicleName(vehicleModel);
      if (vmsg) {
        return res.status(400).json({ success: false, error: vmsg, message: vmsg });
      }
    }
    if (date < todayStr()) {
      return res.status(400).json({
        success: false,
        error: "Date cannot be in the past — rides must start from today onwards",
        message: "Date cannot be in the past — rides must start from today onwards",
      });
    }
    if (date === todayStr() && time < currentHHMM()) {
      return res.status(400).json({
        success: false,
        error: "Time has already passed — please pick a future time",
        message: "Time has already passed — please pick a future time",
      });
    }

    // Normalize the poster's phone to "+91XXXXXXXXXX" so it matches
    // User.phone (which is always saved with the +91 prefix). This
    // makes the driver-name lookup on /details / /connect deterministic.
    const normalizedUserPhone = normalizePhone(userPhone);
    const resolvedUser = await resolveUser({ userId: req.body?.userId, phone: normalizedUserPhone });
    const resolvedUserId = resolvedUser?._id || (req.body?.userId && mongoose.Types.ObjectId.isValid(req.body.userId) ? req.body.userId : null);

    // ── Active Ride Restriction (Creator / Driver) ───────────────────
    // Prevent users from creating conflicting active rides.
    // If the user already has an active created ride, they cannot create another until completed/cancelled.
    const activeCheck = await getUserActiveRideStatus({ userId: resolvedUserId, phone: normalizedUserPhone });
    // IMPORTANT: Live Rides are a SEPARATE workflow and must NOT block normal
    // posting (per spec: keep them separate / don't disturb normal Post Ride).
    // So only a conflicting NORMAL posted ride blocks a new normal post —
    // hosting or joining a Live Ride does not.
    if (activeCheck.hasActiveCreatedRide && activeCheck.activeType === "posted") {
      return res.status(409).json({
        success: false,
        code: "ACTIVE_RIDE_EXISTS",
        error: "You have already started a ride. You cannot start another ride until your current ride is completed or cancelled.",
        message: "You have already started a ride. You cannot start another ride until your current ride is completed or cancelled.",
        activeRideId: activeCheck.activeRideId,
      });
    }
    if (activeCheck.hasActiveJoinedRide && activeCheck.activeType === "posted_passenger") {
      return res.status(409).json({
        success: false,
        code: "ACTIVE_JOINED_RIDE_EXISTS",
        error: "You are currently a passenger on an active ride. You cannot create a ride until your current ride is completed or cancelled.",
        message: "You are currently a passenger on an active ride. You cannot create a ride until your current ride is completed or cancelled.",
        activeRideId: activeCheck.activeRideId,
      });
    }

    // ── Active-plan gate (server-authoritative) ──────────────────────
    // A normal posted ride REQUIRES an active, valid Post plan. This is checked
    // on the backend before saving so the plan can't be bypassed by calling the
    // API directly. The driver never pays twice: if they already hold an active
    // plan this passes; if they just purchased one, verifyPayment created it
    // moments earlier so it's active here too. (Live Rides post to a different
    // endpoint and are free, so they're unaffected.)
    {
      const planVariants = phoneVariantsOf(normalizedUserPhone);
      const activePlan = await Subscription.findOne({
        phone: { $in: planVariants.length ? planVariants : [normalizedUserPhone] },
        purpose: { $ne: "find" },
        status: "active",
        endDate: { $gt: new Date() },
      });
      if (!activePlan) {
        return res.status(402).json({
          success: false,
          code: "PLAN_REQUIRED",
          message: "An active posting plan is required to post a ride. Please choose a plan.",
        });
      }
    }

    // ── Duplicate-ride guard ─────────────────────────────────────────
    // The SAME user may not have two ACTIVE rides at the same date + time.
    // Independent of vehicle / from / to / seats. Different users, different
    // times or different dates are all allowed. Closed/expired rides (e.g. a
    // ride the owner previously cancelled) do NOT block a fresh post.
    const DUP_MSG =
      "You already have a ride scheduled for this date and time. Please choose a different date or time.";
    if (normalizedUserPhone) {
      const dupVariants = phoneVariantsOf(normalizedUserPhone);
      const clash = await Ride.findOne({
        userPhone: { $in: dupVariants.length ? dupVariants : [normalizedUserPhone] },
        date,
        time,
        status: "active",
      }).lean();
      if (clash) {
        return res.status(409).json({ success: false, error: DUP_MSG, message: DUP_MSG });
      }
    }

    // ── Posting subscription gate ─────────────────────────────────────
    // A user must hold an ACTIVE posting plan (daily/monthly/yearly) to post.
    // Enforced here so the API can't be bypassed by calling it directly. This
    // affects POSTING only — finding, requesting, and paying for a confirmed
    // booking are never blocked by this.
    if (normalizedUserPhone) {
      const subVariants = phoneVariantsOf(normalizedUserPhone);
      const activeSub = await Subscription.findOne({
        phone: { $in: subVariants.length ? subVariants : [normalizedUserPhone] },
        purpose: { $ne: "find" }, // "post" or legacy subs without a purpose field
        status: "active",
        endDate: { $gt: new Date() },
      });
      if (!activeSub) {
        return res.status(403).json({
          success: false,
          code: "NO_ACTIVE_PLAN",
          error: "No active posting plan. Please choose a plan to continue posting rides.",
          message: "No active posting plan. Please choose a plan to continue posting rides.",
        });
      }
    }

    const ride = await Ride.create({
      from: from.trim(),
      to: to.trim(),
      date,
      time,
      gender,
      distance,
      duration,
      fromLat: fromLat ?? null,
      fromLon: fromLon ?? null,
      toLat:   toLat   ?? null,
      toLon:   toLon   ?? null,
      userId:  resolvedUserId,
      userPhone: normalizedUserPhone,
      vehicle: vehicle || "Bike",
      vehicleModel: vehicleModel || "",
      vehicleColor: vehicleColor || "",
      plateNumber:  plateNumber  || "",
      seatsAvailable: typeof seatsAvailable === "number" ? seatsAvailable : 1,
      farePerSeat: typeof farePerSeat === "number" ? Math.max(0, farePerSeat) : 0,
      stops: cleanStops,
      additionalInfo: additionalInfo || "",
      petAllowed: derivePetAllowed(additionalInfo),
      smokingAllowed: deriveSmokingAllowed(additionalInfo),
    });

    // Seamlessly integrate live ride tracking: auto-create LiveRide so
    // driver location and live sharing work out of the box with the existing post-ride form.
    try {
      const liveRide = await LiveRide.create({
        hostId: resolvedUserId,
        hostPhone: normalizedUserPhone,
        hostName: resolvedUser?.fullName || "",
        rideId: ride._id,
        vehicle: {
          type: vehicle || "Car",
          model: vehicleModel || "",
          color: vehicleColor || "",
          plate: plateNumber || "",
        },
        from: from.trim(),
        to: to.trim(),
        departureTime: `${date} ${time}`,
        totalSeats: typeof seatsAvailable === "number" ? seatsAvailable : 1,
        farePerSeat: typeof farePerSeat === "number" ? Math.max(0, farePerSeat) : 0,
        currentLat: fromLat ?? null,
        currentLon: fromLon ?? null,
        destLat: toLat ?? null,
        destLon: toLon ?? null,
        lastLocationAt: (fromLat != null && fromLon != null) ? new Date() : null,
        status: "live",
        passengers: [{
          userId: resolvedUserId,
          phone: normalizedUserPhone,
          name: resolvedUser?.fullName || "",
          photo: resolvedUser?.photo || "",
          isHost: true,
          status: "confirmed",
          amountPaid: 0,
          joinedAt: new Date(),
        }],
      });
      ride.liveRideId = liveRide._id;
      await ride.save();
    } catch (liveErr) {
      console.warn("LiveRide auto-creation non-fatal note:", liveErr?.message);
    }

    return res.status(201).json({
      success: true,
      message: "Ride posted successfully",
      data: ride,
    });
  } catch (err) {
    // Race protection: the partial unique index (userPhone+date+time, active
    // only) rejects a second simultaneous insert with a duplicate-key error.
    // Surface the same professional message the pre-check uses.
    if (err && err.code === 11000) {
      const DUP_MSG =
        "You already have a ride scheduled for this date and time. Please choose a different date or time.";
      return res.status(409).json({ success: false, error: DUP_MSG, message: DUP_MSG });
    }
    if (err.name === "ValidationError") {
      const messages = Object.values(err.errors).map((e) => e.message);
      return res.status(400).json({ success: false, error: messages.join(", "), message: messages.join(", ") });
    }
    console.error("createRide error:", err);
    return res.status(500).json({
      success: false,
      error: "Server error while posting ride. Please try again.",
      message: "Server error while posting ride. Please try again.",
    });
  }
});

// ============================================================
// Helper — attach the poster's User profile (fullName + photo)
// to every ride so the FindFriends card can render real avatars.
// ============================================================
// ── Seat availability ────────────────────────────────────────────────
// A seat is "occupied" ONLY by a CONFIRMED (accepted) request. Pending,
// rejected, cancelled and expired requests never consume a seat. If a
// confirmed rider later cancels, their request becomes "cancelled" and the
// seat frees automatically because we only ever count status === "accepted".
const CONFIRMED_STATUS = "accepted"; // "accepted" == CONFIRMED in this codebase

// Count confirmed SEATS for a single ride. A booking may hold more than one
// seat (seatsRequested), so we sum seats — not request documents. Legacy
// requests created before multi-seat have no seatsRequested and count as 1.
async function confirmedCountForRide(rideId) {
  const rows = await RideRequest.aggregate([
    { $match: { rideId: new mongoose.Types.ObjectId(String(rideId)), status: CONFIRMED_STATUS } },
    { $group: { _id: null, seats: { $sum: { $ifNull: ["$seatsRequested", 1] } } } },
  ]);
  return rows.length ? rows[0].seats : 0;
}

// Batch: Map<rideId(string), confirmedSeatCount> for a list of rides.
async function confirmedCountsFor(rideIds) {
  if (!rideIds || !rideIds.length) return new Map();
  const rows = await RideRequest.aggregate([
    { $match: { rideId: { $in: rideIds }, status: CONFIRMED_STATUS } },
    { $group: { _id: "$rideId", n: { $sum: { $ifNull: ["$seatsRequested", 1] } } } },
  ]);
  const map = new Map();
  rows.forEach((r) => map.set(String(r._id), r.n));
  return map;
}

// Attach seat fields to a plain ride object. remainingSeats never goes below 0.
function attachSeatInfo(obj, confirmedCount) {
  const total = typeof obj.seatsAvailable === "number" ? obj.seatsAvailable : 1;
  const confirmed = confirmedCount || 0;
  const remaining = Math.max(0, total - confirmed);
  obj.totalSeats = total;
  obj.confirmedSeats = confirmed;
  obj.remainingSeats = remaining;
  obj.seatsLeft = remaining; // alias for older frontend field names
  obj.isFull = remaining <= 0;
  return obj;
}

const enrichRidesWithUser = async (rides) => {
  const counts = await confirmedCountsFor(rides.map((r) => r._id));
  const out = [];
  for (const r of rides) {
    const obj = r.toObject ? r.toObject() : r;
    // PRIVACY (backend-enforced): a public ride listing is pre-payment by
    // nature, so it must NEVER carry the driver's identity or vehicle
    // identifiers. Only the route, schedule, seats, price, vehicle TYPE
    // (needed for the Car/Bike filter) and ride preferences are public.
    // Real name, photo, city, vehicle model/colour, registration number and
    // contact unlock only through /requests/outgoing once the booking is
    // CONFIRMED + PAID.
    obj.driverName = "Verified Vooggly Rider";
    obj.driverPhoto = "";
    obj.driverCity = "";
    // Never expose a phone/email typed into notes in public ride lists.
    obj.additionalInfo = sanitizeNotes(obj.additionalInfo);
    // Vehicle identity (model / colour / registration) is private pre-payment.
    obj.vehicleModel = "";
    obj.vehicleColor = "";
    obj.plateNumber = "";
    // Pet-allowed boolean: use the stored value, or back-derive from notes for
    // older rides that predate the field, so the filter matches consistently.
    obj.petAllowed = obj.petAllowed === true || derivePetAllowed(obj.additionalInfo);
    obj.smokingAllowed = obj.smokingAllowed === true || deriveSmokingAllowed(obj.additionalInfo);
    // Seat availability based on CONFIRMED requests only.
    attachSeatInfo(obj, counts.get(String(r._id)) || 0);
    out.push(obj);
  }
  return out;
};

// ── Reveal gate ─────────────────────────────────────────────────────
// A viewer may see a ride's private driver + vehicle identity ONLY when
// they hold a CONFIRMED (accepted) + PAID booking for that exact ride.
// This is the single authoritative backend gate shared by /connect and
// /details, matching /requests/outgoing and /:id/unlock. Without a paid,
// accepted request the caller gets generic, non-identifying values.
const viewerMaySeePrivate = async (rideId, viewerPhone) => {
  if (!viewerPhone) return false;
  const variants = phoneVariantsOf(viewerPhone);
  if (!variants.length) return false;
  const paidReq = await RideRequest.findOne({
    rideId,
    riderPhone: { $in: variants },
    status: "accepted",
    paymentStatus: "paid",
  }).lean();
  return !!paidReq;
};

// ============================================================
// GET /api/rides — all rides, newest first (FindFriends)
// ============================================================
router.get("/", async (req, res) => {
  try {
    await sweepExpiredRides();
    const rides = (await Ride.find({ status: { $ne: "closed" } }).sort({ createdAt: -1 }))
      .filter((r) => !isRideExpired(r));
    const enriched = await enrichRidesWithUser(rides);
    return res.status(200).json({ success: true, count: enriched.length, data: enriched });
  } catch (err) {
    console.error("getAllRides error:", err);
    return res.status(500).json({
      success: false,
      error: "Server error while fetching rides. Please try again.",
      message: "Server error while fetching rides. Please try again.",
    });
  }
});

// ============================================================
// GET /api/rides/by-user?phone=…   — profile + posted rides
//
// Used by the Profile Settings page. Returns:
//   • user        – profile snapshot (name, email, photo, gender, etc.)
//   • rides       – every ride this user has posted, newest first
//   • stats       – totals (totalPosted, upcoming, totalSeatsOffered)
//
// Phone numbers can be stored as +91…, 91… or bare 10 digits — we match
// every variant so the count is stable no matter how the phone was saved.
// ============================================================
router.get("/by-user", async (req, res) => {
  try {
    const phoneRaw = String(req.query.phone || "").trim();
    if (!phoneRaw) {
      return res.status(400).json({
        success: false,
        error: "phone query param is required",
        message: "phone query param is required",
      });
    }

    const last10 = phoneRaw.replace(/\D/g, "").slice(-10);
    const phoneVariants = [phoneRaw];
    if (last10.length === 10) {
      phoneVariants.push("+91" + last10, "91" + last10, last10);
    }

    const user = await findUserByPhone(phoneRaw);
    const rides = await Ride.find({ userPhone: { $in: phoneVariants } })
      .sort({ createdAt: -1 });

    const todayISOStr = todayStr();
    const upcoming = rides.filter((r) => (r.date || "") >= todayISOStr).length;
    const totalSeats = rides.reduce(
      (sum, r) => sum + (typeof r.seatsAvailable === "number" ? r.seatsAvailable : 0),
      0
    );
    // Confirmed-seat counts for each of the owner's rides (accepted requests).
    const seatCounts = await confirmedCountsFor(rides.map((r) => r._id));

    return res.status(200).json({
      success: true,
      data: {
        user: user
          ? {
              fullName: user.fullName || "",
              email: user.email || "",
              photo: user.photo || "",
              city: user.city || "",
              gender: user.gender || "",
              phone: user.phone || phoneRaw,
              memberSince: user.createdAt || null,
            }
          : {
              fullName: "",
              email: "",
              photo: "",
              city: "",
              gender: "",
              phone: phoneRaw,
              memberSince: null,
            },
        stats: {
          totalPosted: rides.length,
          upcoming,
          totalSeatsOffered: totalSeats,
        },
        rides: rides.map((r) => ({
          _id: r._id,
          from: r.from,
          to: r.to,
          date: r.date,
          time: r.time,
          gender: r.gender,
          distance: r.distance,
          duration: r.duration,
          vehicle: r.vehicle || "Bike",
          vehicleModel: r.vehicleModel || "",
          vehicleColor: r.vehicleColor || "",
          plateNumber: r.plateNumber || "",
          seatsAvailable: typeof r.seatsAvailable === "number" ? r.seatsAvailable : 1,
          farePerSeat: typeof r.farePerSeat === "number" ? r.farePerSeat : 0,
          totalSeats: typeof r.seatsAvailable === "number" ? r.seatsAvailable : 1,
          confirmedSeats: seatCounts.get(String(r._id)) || 0,
          remainingSeats: Math.max(
            0,
            (typeof r.seatsAvailable === "number" ? r.seatsAvailable : 1) -
              (seatCounts.get(String(r._id)) || 0)
          ),
          isFull:
            (typeof r.seatsAvailable === "number" ? r.seatsAvailable : 1) -
              (seatCounts.get(String(r._id)) || 0) <=
            0,
          additionalInfo: r.additionalInfo || "",
          viewCount: r.viewCount || 0,
          createdAt: r.createdAt,
          // Lifecycle status for the owner's history: active | expired | closed
          status: rideStatusLabel(r),
        })),
      },
    });
  } catch (err) {
    console.error("getRidesByUser error:", err);
    return res.status(500).json({
      success: false,
      error: "Server error while loading your profile",
      message: "Server error while loading your profile",
    });
  }
});

// ============================================================
// GET /api/rides/search?from=&to=&date=&gender= — FindRide → FindFriends
//   ALL params are optional. The endpoint AND-combines whatever is
//   present:
//     • from / to   – partial, case-insensitive match
//     • date        – exact "YYYY-MM-DD" match
//     • gender      – "Male" | "Female" | "Any"
//   At least ONE filter must be supplied — calling /search with no
//   params returns 400 (use GET /api/rides for that).
// ============================================================
router.get("/search", async (req, res) => {
  try {
    // Auto-update ride statuses first: rides whose scheduled date+time has
    // passed flip active → expired, so completed/expired never surface here.
    await sweepExpiredRides();
    // NOTE: date is intentionally NOT used to filter search results — users
    // can find rides without picking a date.
    const { from, to, gender, vehicle, fromLat, fromLon, toLat, toLon } = req.query;

    const fromT    = (from    || "").trim();
    const toT      = (to      || "").trim();
    const genderT  = (gender  || "").trim();
    const vehicleT = (vehicle || "").trim().toLowerCase(); // "car" | "bike" | ""

    const num = (v) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    const fLat = num(fromLat), fLon = num(fromLon);
    const tLat = num(toLat),   tLon = num(toLon);
    const hasFromGeo = fLat !== null && fLon !== null;
    const hasToGeo   = tLat !== null && tLon !== null;

    if (!fromT && !toT && !genderT && !hasFromGeo && !hasToGeo) {
      return res.status(400).json({
        success: false,
        error: "Provide at least one filter (from, to or gender)",
        message: "Provide at least one filter (from, to or gender)",
      });
    }

    // ── Configurable nearby radius (km) ──────────────────────────────
    // Change NEARBY_RADIUS_KM in the backend env to widen/narrow how far
    // "nearby" reaches. Not hardcoded throughout — this single value drives it.
    const RADIUS_KM = num(process.env.NEARBY_RADIUS_KM) || 25;

    const escapeRx = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    // Significant tokens for text/similar-name matching (ignores fillers).
    const STOP = new Set([
      "india", "tamil", "nadu", "state", "district", "near",
      "road", "street", "the", "and", "junction", "railway", "station",
    ]);
    const tokensOf = (s) =>
      String(s).toLowerCase().split(/[^a-z0-9]+/i).filter((t) => t.length >= 3 && !STOP.has(t));

    const textMatch = (storedVal, term) => {
      if (!term) return false;
      const v = String(storedVal || "").toLowerCase();
      if (v.includes(term.toLowerCase())) return true;
      return tokensOf(term).some((t) => v.includes(t));
    };

    // Great-circle distance in km between two lat/lon points.
    const haversineKm = (aLat, aLon, bLat, bLon) => {
      const toRad = (d) => (d * Math.PI) / 180;
      const R = 6371;
      const dLat = toRad(bLat - aLat);
      const dLon = toRad(bLon - aLon);
      const h =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
      return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
    };

    // Candidate rides. With coordinates we match by distance in JS (nearby
    // places have different names, so a text prefilter would miss them), so we
    // pull the gender-filtered set. Without coordinates we keep the fast
    // text/similar-name query.
    let candidates;
    if (hasFromGeo || hasToGeo) {
      const dbq = { status: "active" }; // only active rides (excludes completed/expired/cancelled/closed)
      if (genderT) dbq.gender = { $regex: `^${escapeRx(genderT)}$`, $options: "i" };
      candidates = await Ride.find(dbq).sort({ createdAt: -1 });
    } else {
      // A searched term may match the ride's start, destination OR any
      // intermediate stop — so the DB pre-filter must look in all three
      // (from / to / stops.name). The precise boarding-before-dropping ordering
      // is then enforced in-memory below. Without the stops.name clause, a ride
      // whose match is an intermediate stop would be filtered out here and never
      // scored (the bug that hid stop-based searches with no coordinates).
      const anyFieldMatch = (term) => {
        const ors = [];
        const terms = [term, ...tokensOf(term)];
        ["from", "to", "stops.name"].forEach((field) => {
          terms.forEach((t) => ors.push({ [field]: { $regex: escapeRx(t), $options: "i" } }));
        });
        return { $or: ors };
      };
      const and = [{ status: "active" }]; // only active rides
      if (fromT)   and.push(anyFieldMatch(fromT));
      if (toT)     and.push(anyFieldMatch(toT));
      if (genderT) and.push({ gender: { $regex: `^${escapeRx(genderT)}$`, $options: "i" } });
      candidates = await Ride.find(and.length ? { $and: and } : {}).sort({ createdAt: -1 });
    }

    // Evaluate one location field (from OR to) for a ride.
    // Passes if the field is unconstrained, OR text/similar-name matches, OR
    // (coords supplied AND the ride's stored coords are within RADIUS_KM).
    const evalField = (term, gLat, gLon, hasGeo, rLat, rLon, storedVal) => {
      const constrained = !!term || hasGeo;
      if (!constrained) return { pass: true, dist: 0, exact: false };

      const txtOk = term ? textMatch(storedVal, term) : false;

      let dist = Infinity, geoOk = false;
      const rl = num(rLat), rn = num(rLon);
      if (hasGeo && rl !== null && rn !== null) {
        dist = haversineKm(gLat, gLon, rl, rn);
        geoOk = dist <= RADIUS_KM;
      }
      const exact =
        term && String(storedVal || "").trim().toLowerCase() === term.toLowerCase();
      // Distance used for ranking: exact geo distance if geo-matched, 0 if it
      // matched by text (treat name matches as closest), else Infinity.
      const rankDist = geoOk ? dist : (txtOk ? 0 : Infinity);
      return { pass: txtOk || geoOk, dist: rankDist, exact: !!exact };
    };

    // Never surface expired/closed rides, even to a direct search.
    candidates = candidates.filter((r) => !isRideExpired(r));

    // Vehicle-type filter — case-insensitive (bike/Bike/BIKE all match).
    if (vehicleT) {
      candidates = candidates.filter(
        (r) => String(r.vehicle || "").trim().toLowerCase() === vehicleT
      );
    }

    // Evaluate a search term/geo against a RANGE of the ordered route sequence
    // (start → stops → end) and return the best-matching point WITH its index,
    // so we can enforce boarding-before-dropping. idx = -1 when unconstrained.
    const bestMatch = (term, gLat, gLon, hasGeo, seq, lo, hi) => {
      if (!term && !hasGeo) return { pass: true, dist: 0, exact: false, idx: -1 };
      let best = { pass: false, dist: Infinity, exact: false, idx: -1 };
      for (let i = lo; i <= hi; i++) {
        const p = seq[i];
        if (!p) continue;
        const r = evalField(term, gLat, gLon, hasGeo, p.lat, p.lon, p.name);
        if (r.pass && (!best.pass || r.dist < best.dist || (r.exact && !best.exact))) {
          best = { ...r, idx: i };
        }
      }
      return best;
    };

    const scored = [];
    for (const r of candidates) {
      const stopPts = (r.stops || []).map((s) => ({ lat: s.lat, lon: s.lon, name: s.name }));
      // Ordered route: start (0) → stops (1..n) → end (last).
      const seq = [
        { lat: r.fromLat, lon: r.fromLon, name: r.from },
        ...stopPts,
        { lat: r.toLat, lon: r.toLon, name: r.to },
      ];
      // Boarding can be the start or any stop (not the final destination);
      // dropping can be any stop or the destination (not the start).
      const fromR = bestMatch(fromT, fLat, fLon, hasFromGeo, seq, 0, seq.length - 2);
      const toR   = bestMatch(toT,   tLat, tLon, hasToGeo,   seq, 1, seq.length - 1);
      if (!fromR.pass || !toR.pass) continue;
      // Boarding must come before dropping on the route (when both are pinned to
      // a specific point). Skips reverse-direction false matches.
      if (fromR.idx >= 0 && toR.idx >= 0 && fromR.idx >= toR.idx) continue;

      const dist =
        (Number.isFinite(fromR.dist) ? fromR.dist : 0) +
        (Number.isFinite(toR.dist) ? toR.dist : 0);
      const exactScore = (fromR.exact ? 1 : 0) + (toR.exact ? 1 : 0);
      scored.push({ ride: r, dist, exactScore });
    }

    // Prioritise exact matches, then nearest by combined distance.
    scored.sort((a, b) => (b.exactScore - a.exactScore) || (a.dist - b.dist));
    let rides = scored.map((s) => s.ride);

    // ── Only show rides that still have a free seat ──────────────────────
    // Confirmed (accepted) requests occupy seats; a ride whose seats are all
    // taken is hidden from search.
    if (rides.length) {
      const counts = await confirmedCountsFor(rides.map((r) => r._id));
      rides = rides.filter((r) => {
        const total = typeof r.seatsAvailable === "number" ? r.seatsAvailable : 1;
        const taken = counts.get(String(r._id)) || 0;
        return total - taken > 0;
      });
    }

    // ── Also include matching ACTIVE live rides ──────────────────────────
    // Live Ride Sharing rides are searchable in Find Ride too. They match by the
    // same ordered route logic (start → stops → destination, boarding before
    // dropping) and are tagged isLive so the card routes to the live join flow.
    const liveResults = [];
    try {
      const liveRides = await LiveRide.find({ status: "live" }).sort({ createdAt: -1 });
      for (const lr of liveRides) {
        const stopPts = (lr.stops || []).map((s) => ({ lat: s.lat, lon: s.lon, name: s.name }));
        const seq = [
          { lat: lr.fromLat, lon: lr.fromLon, name: lr.from },
          ...stopPts,
          { lat: (lr.toLat != null ? lr.toLat : lr.destLat), lon: (lr.toLon != null ? lr.toLon : lr.destLon), name: lr.to },
        ];
        const fromR = bestMatch(fromT, fLat, fLon, hasFromGeo, seq, 0, seq.length - 2);
        const toR   = bestMatch(toT,   tLat, tLon, hasToGeo,   seq, 1, seq.length - 1);
        if (!fromR.pass || !toR.pass) continue;
        if (fromR.idx >= 0 && toR.idx >= 0 && fromR.idx >= toR.idx) continue;
        if (vehicleT && String(lr.vehicle?.type || "").trim().toLowerCase() !== vehicleT) continue;
        const confirmed = (lr.passengers || []).filter((p) => p.status === "confirmed").length;
        const remaining = Math.max(0, (lr.totalSeats || 1) - confirmed);
        if (remaining <= 0) continue; // only rides still accepting riders
        liveResults.push({
          _id: lr._id,
          isLive: true,
          liveRideId: lr._id,
          from: lr.from, to: lr.to,
          stops: lr.stops || [],
          fromLat: lr.fromLat, fromLon: lr.fromLon,
          toLat: (lr.toLat != null ? lr.toLat : lr.destLat),
          toLon: (lr.toLon != null ? lr.toLon : lr.destLon),
          vehicle: (lr.vehicle && lr.vehicle.type) || "Car",
          vehicleModel: "", vehicleColor: "", plateNumber: "",
          farePerSeat: lr.farePerSeat || 0,
          seatsAvailable: lr.totalSeats || 1,
          confirmedSeats: confirmed,
          remainingSeats: remaining, seatsLeft: remaining, isFull: false,
          driverName: "Verified Vooggly Rider", driverPhoto: "", driverCity: "",
          additionalInfo: "", gender: "",
          date: "", time: "",
          viewCount: 0,
          status: "active",
          createdAt: lr.createdAt,
        });
      }
    } catch (e) { /* non-fatal — live rides are a bonus layer on search */ }

    const enriched = rides.length ? await enrichRidesWithUser(rides) : [];
    const data = [...enriched, ...liveResults];
    if (data.length === 0) {
      return res.status(200).json({ success: true, count: 0, message: "Ride not available", data: [] });
    }
    return res.status(200).json({ success: true, count: data.length, data });
  } catch (err) {
    console.error("searchRides error:", err);
    return res.status(500).json({
      success: false,
      error: "Server error while searching rides. Please try again.",
      message: "Server error while searching rides. Please try again.",
    });
  }
});

// ============================================================
// GET /api/rides/:id/connect — driver name + masked phone
// ============================================================
router.get("/:id/connect", async (req, res) => {
  try {
    const { id } = req.params;

    const ride = await Ride.findById(id);
    if (!ride) {
      return res.status(404).json({
        success: false,
        error: "Ride not found",
        message: "Ride not found",
      });
    }

    if (isRideExpired(ride)) {
      return res.status(200).json({
        success: true,
        expired: true,
        message: "This ride has expired or been closed",
        data: { ride: { _id: ride._id, from: ride.from, to: ride.to, date: ride.date, time: ride.time, status: rideStatusLabel(ride) } },
      });
    }

    Ride.updateOne({ _id: id }, { $inc: { viewCount: 1 } }).catch(() => {});

    const user = await findUserByPhone(ride.userPhone);

    // PRIVACY: only a viewer with a CONFIRMED + PAID booking for this ride may
    // see the driver's real identity + full vehicle details. The viewer is
    // identified by ?phone= (their own session phone), exactly like the rest
    // of the app's rider endpoints.
    const viewerPhone = String(req.query.phone || "").trim();
    const maySee = await viewerMaySeePrivate(ride._id, viewerPhone);

    const driverName = maySee
      ? (user?.fullName?.trim() || "Vooggly Rider")
      : "Verified Vooggly Rider";

    // Seat availability — occupied seats = CONFIRMED (accepted) requests only.
    const totalSeats = typeof ride.seatsAvailable === "number" ? ride.seatsAvailable : 1;
    const confirmedSeats = await confirmedCountForRide(ride._id);
    const remainingSeats = Math.max(0, totalSeats - confirmedSeats);

    return res.status(200).json({
      success: true,
      data: {
        ride: {
          _id: ride._id,
          from: ride.from,
          to: ride.to,
          date: ride.date,
          time: ride.time,
          gender: ride.gender,
          distance: ride.distance,
          duration: ride.duration,
          fromLat: ride.fromLat,
          fromLon: ride.fromLon,
          toLat: ride.toLat,
          toLon: ride.toLon,
          stops: ride.stops || [],
          vehicle: ride.vehicle || "Bike", // vehicle TYPE is public (non-identifying)
          vehicleModel: maySee ? (ride.vehicleModel || "") : "",
          vehicleColor: maySee ? (ride.vehicleColor || "") : "",
          plateNumber: maySee ? (ride.plateNumber || "") : "", // registration locked until confirmed + paid
          seatsAvailable: totalSeats,
          farePerSeat: ride.farePerSeat || 0,
          totalSeats,
          confirmedSeats,
          remainingSeats,
          seatsLeft: remainingSeats,
          isFull: remainingSeats <= 0,
          additionalInfo: sanitizeNotes(ride.additionalInfo),
          viewCount: (ride.viewCount || 0) + 1,
          createdAt: ride.createdAt,
        },
        user: {
          fullName: driverName,
          photo: maySee ? (user?.photo || "") : "",
          city: maySee ? (user?.city || "") : "",
          phone: maySee ? (ride.userPhone || "") : "",
          // Contact is exposed ONLY to a confirmed, paid rider (maySee).
        },
      },
    });
  } catch (err) {
    if (err.name === "CastError") {
      return res.status(400).json({
        success: false,
        error: "Invalid ride id",
        message: "Invalid ride id",
      });
    }
    console.error("getRideConnect error:", err);
    return res.status(500).json({
      success: false,
      error: "Server error while loading connect page",
      message: "Server error while loading connect page",
    });
  }
});

// ============================================================
// GET /api/rides/:id/details — full ride + driver profile + stats
//   Used by the RideDetail page (the "View Ride" CTA on RideLive).
//   Returns the same ride payload as /connect plus driver-level stats:
//     • totalPostedRides — how many rides this user has ever posted
//     • upcomingRides    — count of future rides by the same user
// ============================================================
router.get("/:id/details", async (req, res) => {
  try {
    const { id } = req.params;
    const ride = await Ride.findById(id);
    if (!ride) {
      return res.status(404).json({
        success: false,
        error: "Ride not found",
        message: "Ride not found",
      });
    }

    if (isRideExpired(ride)) {
      return res.status(200).json({
        success: true,
        expired: true,
        message: "This ride has expired or been closed",
        data: { ride: { _id: ride._id, from: ride.from, to: ride.to, date: ride.date, time: ride.time, status: rideStatusLabel(ride) } },
      });
    }

    const user = await findUserByPhone(ride.userPhone);

    // PRIVACY: identify the viewer by their own ?phone= and reveal the real
    // driver identity + vehicle details ONLY when they hold a confirmed + paid
    // booking for this ride. Otherwise everything identifying is withheld.
    const viewerPhone = String(req.query.phone || "").trim();
    const maySee = await viewerMaySeePrivate(ride._id, viewerPhone);

    // Phones can be stored as +91… / 91… / bare 10-digits. Match any of
    // those forms when counting the driver's total posts.
    const driverPhone = String(ride.userPhone || "").trim();
    const last10 = driverPhone.replace(/\D/g, "").slice(-10);
    const phoneVariants = driverPhone ? [driverPhone] : [];
    if (last10.length === 10) {
      phoneVariants.push("+91" + last10, "91" + last10, last10);
    }

    const phoneClause = phoneVariants.length
      ? { userPhone: { $in: phoneVariants } }
      : { userPhone: driverPhone };

    const todayISOStr = todayStr();
    const [totalPostedRides, upcomingRides, confirmedSeats] = await Promise.all([
      driverPhone ? Ride.countDocuments(phoneClause) : Promise.resolve(0),
      driverPhone
        ? Ride.countDocuments({ ...phoneClause, date: { $gte: todayISOStr } })
        : Promise.resolve(0),
      confirmedCountForRide(ride._id),
    ]);

    // Seat availability — occupied seats = CONFIRMED (accepted) requests only.
    const totalSeats = typeof ride.seatsAvailable === "number" ? ride.seatsAvailable : 1;
    const remainingSeats = Math.max(0, totalSeats - confirmedSeats);

    return res.status(200).json({
      success: true,
      data: {
        ride: {
          _id: ride._id,
          from: ride.from,
          to: ride.to,
          date: ride.date,
          time: ride.time,
          gender: ride.gender,
          distance: ride.distance,
          duration: ride.duration,
          fromLat: ride.fromLat,
          fromLon: ride.fromLon,
          toLat: ride.toLat,
          toLon: ride.toLon,
          stops: ride.stops || [],
          vehicle: ride.vehicle || "Bike", // vehicle TYPE is public (non-identifying)
          vehicleModel: maySee ? (ride.vehicleModel || "") : "",
          vehicleColor: maySee ? (ride.vehicleColor || "") : "",
          plateNumber: maySee ? (ride.plateNumber || "") : "", // registration locked until confirmed + paid
          seatsAvailable: totalSeats,
          farePerSeat: ride.farePerSeat || 0,
          totalSeats,
          confirmedSeats,
          remainingSeats,
          seatsLeft: remainingSeats,
          isFull: remainingSeats <= 0,
          additionalInfo: sanitizeNotes(ride.additionalInfo),
          viewCount: ride.viewCount || 0,
          createdAt: ride.createdAt,
          status: rideStatusLabel(ride),
        },
        driver: {
          // Identity is revealed ONLY to a confirmed, paid rider (maySee).
          // Before that the viewer sees a neutral, non-identifying label.
          fullName: maySee ? (user?.fullName?.trim() || "Vooggly Rider") : "Verified Vooggly Rider",
          photo: maySee ? (user?.photo || "") : "",
          city: maySee ? (user?.city || "") : "",
          email: maySee ? (user?.email || "") : "",
          phone: maySee ? (ride.userPhone || "") : "",
          stats: {
            totalPostedRides,
            upcomingRides,
            memberSince: user?.createdAt || null,
          },
        },
      },
    });
  } catch (err) {
    if (err.name === "CastError") {
      return res.status(400).json({
        success: false,
        error: "Invalid ride id",
        message: "Invalid ride id",
      });
    }
    console.error("getRideDetails error:", err);
    return res.status(500).json({
      success: false,
      error: "Server error while loading ride details",
      message: "Server error while loading ride details",
    });
  }
});

// ============================================================
// POST /api/rides/:id/unlock — reveal full driver phone
// ============================================================
router.post("/:id/unlock", async (req, res) => {
  try {
    const { id } = req.params;

    const ride = await Ride.findById(id);
    if (!ride) {
      return res.status(404).json({
        success: false,
        error: "Ride not found",
        message: "Ride not found",
      });
    }

    if (!ride.userPhone) {
      return res.status(404).json({
        success: false,
        error: "No contact info available for this ride",
        message: "No contact info available for this ride",
      });
    }

    // Record this unlock as a Booking so it shows in the admin panel.
    // Keyed on (rideId, riderPhone) and upserted, so re-unlocking the
    // same ride doesn't create duplicate bookings.
    const riderPhone = normalizePhone(req.body?.riderPhone || "");
    const posterPhone = ride.userPhone;
    if (riderPhone && riderPhone !== normalizePhone(posterPhone)) {
      try {
        const [rider, poster] = await Promise.all([
          findUserByPhone(riderPhone),
          findUserByPhone(posterPhone),
        ]);
        await Booking.findOneAndUpdate(
          { rideId: ride._id, riderPhone },
          {
            $setOnInsert: {
              rideId: ride._id,
              from: ride.from,
              to: ride.to,
              date: ride.date,
              time: ride.time,
              posterPhone,
              posterName: poster?.fullName || "",
              riderPhone,
              riderName: rider?.fullName || "",
              status: "booked",
            },
          },
          { upsert: true, new: true }
        );
      } catch (bookingErr) {
        // Non-fatal — never block the contact reveal on a booking write.
        console.warn("[unlock] Booking record skipped:", bookingErr.message);
      }
    }

    // SECURITY: only return the real driver number when the caller has a
    // CONFIRMED + PAID booking for this ride. Without it, the booking is still
    // logged (side effect above) but no contact is returned.
    const paidReq = riderPhone
      ? await RideRequest.findOne({
          rideId: ride._id,
          riderPhone: { $in: phoneVariantsOf(riderPhone) },
          status: "accepted",
          paymentStatus: "paid",
        })
      : null;

    return res.status(200).json({
      success: true,
      message: paidReq ? "Contact unlocked" : "Contact locked until payment",
      data: { phone: paidReq ? ride.userPhone : "" },
    });
  } catch (err) {
    if (err.name === "CastError") {
      return res.status(400).json({
        success: false,
        error: "Invalid ride ID",
        message: "Invalid ride ID",
      });
    }
    return res.status(500).json({
      success: false,
      error: err.message || "Internal server error",
      message: err.message || "Internal server error",
    });
  }
});


// ============================================================
// PATCH /api/rides/:id — owner edits an existing ride
//
// Body accepts any of: date, time, seatsAvailable, gender,
// vehicle, vehicleModel, vehicleColor, plateNumber, additionalInfo
// Requires phone (in body or query) and only the ride owner can edit.
// ============================================================
router.patch("/:id", async (req, res) => {
  try {
    const rideId = String(req.params.id || "");
    if (!rideId) {
      return res.status(400).json({ success: false, error: "Ride id required", message: "Ride id required" });
    }

    const phoneRaw = String(req.body?.phone || req.query?.phone || "").trim();
    if (!phoneRaw) {
      return res.status(400).json({ success: false, error: "phone is required", message: "phone is required" });
    }
    const last10 = phoneRaw.replace(/\D/g, "").slice(-10);
    const phoneVariants = [phoneRaw];
    if (last10.length === 10) {
      phoneVariants.push("+91" + last10, "91" + last10, last10);
    }

    const ride = await Ride.findById(rideId);
    if (!ride) {
      return res.status(404).json({ success: false, error: "Ride not found", message: "Ride not found" });
    }
    if (!phoneVariants.includes(ride.userPhone)) {
      return res.status(403).json({
        success: false,
        error: "You do not own this ride",
        message: "You do not own this ride",
      });
    }

    // Whitelist editable fields so the user can't reassign owner / coords etc.
    const editable = [
      "date", "time", "seatsAvailable", "farePerSeat", "gender",
      "vehicle", "vehicleModel", "vehicleColor", "plateNumber",
      "additionalInfo",
    ];
    for (const k of editable) {
      if (Object.prototype.hasOwnProperty.call(req.body || {}, k)) {
        if (k === "seatsAvailable") {
          const n = Number(req.body[k]);
          if (!Number.isFinite(n) || n < 1 || n > 8) {
            return res.status(400).json({
              success: false, error: "Seats must be 1-8", message: "Seats must be 1-8",
            });
          }
          ride[k] = n;
        } else if (k === "farePerSeat") {
          const n = Number(req.body[k]);
          ride[k] = Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
        } else if (k === "plateNumber") {
          ride[k] = String(req.body[k] || "").toUpperCase().replace(/[\s-]/g, "");
        } else if (k === "vehicleModel") {
          const vmsg = validateVehicleName(req.body[k]);
          if (vmsg) return res.status(400).json({ success: false, error: vmsg, message: vmsg });
          ride[k] = String(req.body[k]).trim();
        } else {
          ride[k] = req.body[k];
        }
      }
    }

    await ride.save();
    return res.status(200).json({
      success: true,
      message: "Ride updated",
      data: { ride },
    });
  } catch (err) {
    console.error("PATCH ride error:", err);
    return res.status(500).json({
      success: false,
      error: err.message || "Internal server error",
      message: err.message || "Internal server error",
    });
  }
});

// ============================================================
// DELETE /api/rides/:id — owner deletes their own ride
// phone passed in body OR query string for ownership check.
// ============================================================
router.delete("/:id", async (req, res) => {
  try {
    const rideId = String(req.params.id || "");
    if (!rideId) {
      return res.status(400).json({ success: false, error: "Ride id required", message: "Ride id required" });
    }

    const phoneRaw = String(req.body?.phone || req.query?.phone || "").trim();
    if (!phoneRaw) {
      return res.status(400).json({ success: false, error: "phone is required", message: "phone is required" });
    }
    const last10 = phoneRaw.replace(/\D/g, "").slice(-10);
    const phoneVariants = [phoneRaw];
    if (last10.length === 10) {
      phoneVariants.push("+91" + last10, "91" + last10, last10);
    }

    const ride = await Ride.findById(rideId);
    if (!ride) {
      return res.status(404).json({ success: false, error: "Ride not found", message: "Ride not found" });
    }
    if (!phoneVariants.includes(ride.userPhone)) {
      return res.status(403).json({
        success: false,
        error: "You do not own this ride",
        message: "You do not own this ride",
      });
    }

    await Ride.deleteOne({ _id: ride._id });
    if (ride.liveRideId) {
      await LiveRide.findByIdAndUpdate(ride.liveRideId, { status: "ended", endedAt: new Date() });
    }
    await LiveRide.deleteMany({ rideId: ride._id });

    return res.status(200).json({
      success: true,
      message: "Ride deleted",
      data: { _id: ride._id },
    });
  } catch (err) {
    console.error("DELETE ride error:", err);
    return res.status(500).json({
      success: false,
      error: err.message || "Internal server error",
      message: err.message || "Internal server error",
    });
  }
});

// ============================================================
// REQUEST TO RIDE — request / accept / reject / cancel / close
// Contact is revealed only once a request is ACCEPTED.
// ============================================================

// DEPRECATED — the old FREE request endpoint. The flow is now PAY-FIRST, so a
// request can no longer be created for free. A stale client hitting this is
// told to use the new flow (prevents bypassing payment).
router.post("/:id/request", async (req, res) => {
  return res.status(426).json({
    success: false,
    code: "PAYMENT_REQUIRED_FIRST",
    message: "Payment is required before sending a ride request. Please refresh the page and try again.",
  });
});

// POST /api/rides/:id/request-order  { riderPhone, userId?, message? }
// PAY-FIRST step 1: validate eligibility and create (or reuse) a Razorpay order
// for the booking fee. Creates a hidden "awaiting_payment" request that holds
// the order. The owner is NOT notified yet — the request is only sent after the
// payment is verified in step 2.
router.post("/:id/request-order", async (req, res) => {
  try {
    const riderPhone = normalizePhone(req.body?.riderPhone || "");
    const message = String(req.body?.message || "").slice(0, 300);
    if (!riderPhone) return res.status(400).json({ success: false, message: "Rider phone is required" });
    // Auth gate: only a real, verified account may request/pay.
    if (!(await requireVerifiedRider(riderPhone, res))) return;

    // Boarding / dropping / seats requested by the rider (optional — defaults
    // to the full origin→destination for 1 seat). Validated against the ride's
    // route below once the ride is loaded.
    const reqBoarding = String(req.body?.boardingPoint || "").trim();
    const reqDropping = String(req.body?.droppingPoint || "").trim();
    let seatsWanted = parseInt(req.body?.seatsRequested, 10);
    if (!Number.isInteger(seatsWanted) || seatsWanted < 1) seatsWanted = 1;

    const rider = await resolveUser({ userId: req.body?.userId, phone: riderPhone });
    const riderUserId = rider?._id || (req.body?.userId && mongoose.Types.ObjectId.isValid(req.body.userId) ? req.body.userId : null);

    const ride = await Ride.findById(req.params.id);
    if (!ride) return res.status(404).json({ success: false, message: "Ride not found" });
    if (isRideExpired(ride)) return res.status(400).json({ success: false, message: "This ride has expired or been closed" });
    if (samePhone(ride.userPhone, riderPhone) || (riderUserId && ride.userId && String(riderUserId) === String(ride.userId))) {
      return res.status(400).json({ success: false, message: "You can't request your own ride" });
    }

    // ── Ride Creator Restriction ──────────────────────────────────────────
    // Once a user posts/starts a ride, that user becomes the ride creator and driver.
    // The same user must NOT be allowed to join another ride while their created ride is active.
    const activeStatus = await getUserActiveRideStatus({ userId: riderUserId, phone: riderPhone });
    if (activeStatus.hasActiveCreatedRide) {
      return res.status(403).json({
        success: false,
        code: "ACTIVE_RIDE_EXISTS",
        message: "You have already started a ride. You cannot join another ride until your current ride is completed or cancelled.",
        activeRideId: activeStatus.activeRideId,
      });
    }
    if (activeStatus.hasActiveJoinedRide) {
      return res.status(403).json({
        success: false,
        code: "ACTIVE_JOINED_RIDE_EXISTS",
        message: "You have already joined another active ride as a passenger.",
        activeRideId: activeStatus.activeRideId,
      });
    }

    // Duplicate guard — one live request per rider per ride.
    let reqDoc = await RideRequest.findOne({ rideId: ride._id, riderPhone });
    if (reqDoc && (reqDoc.status === "pending" || reqDoc.status === "accepted")) {
      return res.status(409).json({ success: false, message: "You have already requested this ride.", data: { _id: reqDoc._id, status: reqDoc.status } });
    }

    // ── Boarding / dropping validation against the ride's ordered route ──
    // Sequence: origin (0) → intermediate stops (1..n) → destination (last).
    const routeSeq = [
      ride.from,
      ...((ride.stops || []).map((s) => (s && s.name) || "").filter(Boolean)),
      ride.to,
    ];
    const norm = (s) => String(s || "").trim().toLowerCase();
    // Match a chosen point to a route position (exact, else contains either way).
    const findIdx = (val) => {
      const v = norm(val);
      if (!v) return -1;
      let i = routeSeq.findIndex((p) => norm(p) === v);
      if (i >= 0) return i;
      return routeSeq.findIndex((p) => norm(p).includes(v) || v.includes(norm(p)));
    };
    // Default to full journey when the rider didn't choose explicit points.
    let boardingIndex = reqBoarding ? findIdx(reqBoarding) : 0;
    let droppingIndex = reqDropping ? findIdx(reqDropping) : routeSeq.length - 1;
    if (reqBoarding && boardingIndex < 0) {
      return res.status(400).json({ success: false, message: "Boarding point is not on this ride's route." });
    }
    if (reqDropping && droppingIndex < 0) {
      return res.status(400).json({ success: false, message: "Dropping point is not on this ride's route." });
    }
    // Boarding must come strictly before dropping in route order.
    if (boardingIndex >= droppingIndex) {
      return res.status(400).json({ success: false, message: "Your boarding point must come before your dropping point along the route." });
    }
    const boardingPoint = routeSeq[boardingIndex];
    const droppingPoint = routeSeq[droppingIndex];

    // Seat guard — the requested number of seats must fit in what's left.
    const totalSeats = typeof ride.seatsAvailable === "number" ? ride.seatsAvailable : 1;
    const confirmedSeats = await confirmedCountForRide(ride._id);
    const seatsLeft = totalSeats - confirmedSeats;
    if (seatsLeft <= 0) {
      return res.status(409).json({ success: false, message: "This ride is full — no seats are available." });
    }
    if (seatsWanted > seatsLeft) {
      return res.status(409).json({ success: false, message: `Only ${seatsLeft} seat(s) left — please reduce the number of seats.` });
    }

    // Fee (admin-configured Find Ride daily price), in rupees.
    const feeRupees = await planCtrl.loadBookingFee();
    const amountPaise = Math.round(Number(feeRupees) * 100);
    if (!(amountPaise > 0)) {
      return res.status(500).json({ success: false, message: "Booking fee is not configured. Please try again later." });
    }

    const client = planCtrl.getRazorpayClient();
    if (!client) return res.status(500).json({ success: false, message: "Payment is temporarily unavailable. Please try again later." });
    const KEY = process.env.RAZORPAY_KEY_ID;

    const snap = {
      posterId: ride.userId || null,
      posterPhone: ride.userPhone,
      riderId: riderUserId,
      riderPhone,
      riderName: rider?.fullName || "",
      riderPhoto: rider?.photo || "",
      riderCity: rider?.city || "",
      message,
      boardingPoint,
      droppingPoint,
      boardingIndex,
      droppingIndex,
      seatsRequested: seatsWanted,
      status: "awaiting_payment",
      paymentStatus: "pending",
      amountDue: Number(feeRupees),
    };
    if (reqDoc) { Object.assign(reqDoc, snap); }
    else { reqDoc = new RideRequest({ rideId: ride._id, ...snap }); }

    // Reuse an existing unpaid order so refresh/retry can't spawn duplicates.
    let order = null;
    if (reqDoc.paymentOrderId) {
      try {
        const existing = await client.orders.fetch(reqDoc.paymentOrderId);
        if (existing && existing.status !== "paid") order = existing;
      } catch (_e) { /* create a fresh one below */ }
    }
    if (!order) {
      order = await client.orders.create({
        amount: amountPaise,
        currency: "INR",
        receipt: `req_${reqDoc._id}`,
        notes: { rideId: String(ride._id), riderPhone, purpose: "ride_request" },
      });
      reqDoc.paymentOrderId = order.id;
    }
    await reqDoc.save();

    return res.status(201).json({
      success: true,
      bookingId: reqDoc._id,
      orderId: order.id,
      amount: order.amount,        // paise
      amountRupees: Number(feeRupees),
      currency: order.currency || "INR",
      key: KEY,
    });
  } catch (err) {
    if (err && err.code === 11000) {
      return res.status(409).json({ success: false, message: "You have already requested this ride." });
    }
    console.error("requestOrder error:", err);
    return res.status(500).json({ success: false, message: "Server error while starting payment" });
  }
});

// POST /api/rides/requests/:reqId/request-pay-verify
//   { riderPhone, razorpay_order_id, razorpay_payment_id, razorpay_signature }
// PAY-FIRST step 2: verify the payment signature, then SEND the request to the
// owner (status awaiting_payment → pending) and notify them. Idempotent.
router.post("/requests/:reqId/request-pay-verify", async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};
    const reqDoc = await RideRequest.findById(req.params.reqId);
    if (!reqDoc) return res.status(404).json({ success: false, message: "Request not found" });
    if (!samePhone(reqDoc.riderPhone, req.body?.riderPhone)) {
      return res.status(403).json({ success: false, message: "Not authorized" });
    }
    if (!(await requireVerifiedRider(req.body?.riderPhone, res))) return;

    // Idempotent — already paid & confirmed (or legacy pending).
    if (reqDoc.paymentStatus === "paid" && (reqDoc.status === "accepted" || reqDoc.status === "pending")) {
      return res.json({ success: true, alreadySent: true, confirmed: reqDoc.status === "accepted", data: reqDoc });
    }
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ success: false, message: "Missing payment confirmation details" });
    }
    const expected = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(razorpay_order_id + "|" + razorpay_payment_id)
      .digest("hex");
    if (expected !== razorpay_signature) {
      return res.status(401).json({ success: false, message: "Payment could not be verified." });
    }

    // Double check that rider does not have an active created ride
    const activeCheck = await getUserActiveRideStatus({ userId: reqDoc.riderId, phone: reqDoc.riderPhone });
    if (activeCheck.hasActiveCreatedRide) {
      reqDoc.paymentStatus = "paid"; reqDoc.paymentId = razorpay_payment_id;
      reqDoc.amountPaid = reqDoc.amountDue; reqDoc.paidAt = new Date();
      reqDoc.status = "cancelled";
      await reqDoc.save();
      await refundRequestPayment(reqDoc, "driver_has_active_ride");
      return res.status(403).json({
        success: false,
        refunded: true,
        code: "ACTIVE_RIDE_EXISTS",
        message: "You have already started a ride. You cannot join another ride until your current ride is completed or cancelled. Your payment has been refunded.",
      });
    }

    const ride = await Ride.findById(reqDoc.rideId);
    if (!ride || isRideExpired(ride)) {
      // Ride gone/expired between order and payment → refund, don't send.
      reqDoc.paymentStatus = "paid"; reqDoc.paymentId = razorpay_payment_id;
      reqDoc.amountPaid = reqDoc.amountDue; reqDoc.paidAt = new Date();
      reqDoc.status = "cancelled";
      await reqDoc.save();
      await refundRequestPayment(reqDoc, "ride_unavailable");
      return res.status(409).json({ success: false, refunded: true, message: "This ride is no longer available. Your payment has been refunded." });
    }
    // Seats may have filled while paying → refund, don't send. Accounts for
    // the number of seats this booking needs (not just one).
    const totalSeats = typeof ride.seatsAvailable === "number" ? ride.seatsAvailable : 1;
    const confirmedSeats = await confirmedCountForRide(ride._id);
    const needSeats = Math.max(1, Number(reqDoc.seatsRequested) || 1);
    if (confirmedSeats + needSeats > totalSeats) {
      reqDoc.paymentStatus = "paid"; reqDoc.paymentId = razorpay_payment_id;
      reqDoc.amountPaid = reqDoc.amountDue; reqDoc.paidAt = new Date();
      reqDoc.status = "cancelled";
      await reqDoc.save();
      await refundRequestPayment(reqDoc, "ride_full");
      return res.status(409).json({ success: false, refunded: true, message: "This ride just became full. Your payment has been refunded." });
    }

    // Success → payment verified. The booking is CONFIRMED immediately — no
    // driver approval/waiting step. Seats update automatically because the
    // seat accounting counts "accepted" requests.
    reqDoc.paymentStatus = "paid";
    reqDoc.paymentId = razorpay_payment_id;
    reqDoc.amountPaid = reqDoc.amountDue;
    reqDoc.paidAt = new Date();
    reqDoc.status = "accepted"; // CONFIRMED on payment (instant booking)
    reqDoc.requestExpiresAt = null; // no owner-response timer
    if (!reqDoc.bookingCode) {
      reqDoc.bookingCode =
        "VGY-" + String(reqDoc._id).slice(-5).toUpperCase() +
        Math.floor(10 + Math.random() * 89);
    }
    await reqDoc.save();

    const seg = (reqDoc.boardingPoint && reqDoc.droppingPoint)
      ? `${reqDoc.boardingPoint} → ${reqDoc.droppingPoint}`
      : `${ride.from} → ${ride.to}`;

    // Notify the DRIVER: a confirmed booking (no action required).
    notify(ride.userPhone, "New Confirmed Booking",
      `${reqDoc.riderName || "A passenger"} booked ${reqDoc.seatsRequested || 1} seat(s) on your ride (${seg}). Booking ${reqDoc.bookingCode}.`,
      "/requests");
    sendSms(ride.userPhone,
      `Vooggly: ${reqDoc.riderName || "A passenger"} confirmed a booking (${seg}, ${reqDoc.seatsRequested || 1} seat/s). Ref ${reqDoc.bookingCode}.`);

    // Notify the RIDER: booking confirmed, contact details now available.
    notify(reqDoc.riderPhone, "Booking Confirmed",
      `Your booking is confirmed (${seg}). Booking ${reqDoc.bookingCode}. You can now view the driver's contact and vehicle details.`,
      "/requests?tab=sent");

    return res.json({
      success: true,
      confirmed: true,
      message: "Payment successful — your booking is confirmed.",
      bookingCode: reqDoc.bookingCode,
      data: reqDoc,
    });
  } catch (err) {
    console.error("requestPayVerify error:", err);
    return res.status(500).json({ success: false, message: "Server error while confirming payment" });
  }
});

// GET /api/rides/requests/incoming?phone=  — requests for MY rides (owner)
router.get("/requests/incoming", async (req, res) => {
  try {
    await sweepExpiredRides();
    await sweepExpiredRequests();
    const variants = phoneVariantsOf(req.query.phone);
    if (!variants.length) return res.status(400).json({ success: false, message: "phone is required" });
    // Never show the owner an unpaid hold — only requests that were actually sent.
    const reqs = await RideRequest.find({
      posterPhone: { $in: variants },
      status: { $ne: "awaiting_payment" },
    }).sort({ createdAt: -1 }).lean();
    const rideIds = [...new Set(reqs.map((r) => String(r.rideId)))];
    const rides = await Ride.find({ _id: { $in: rideIds } }).lean();
    const rideMap = {}; rides.forEach((r) => { rideMap[String(r._id)] = r; });
    const data = reqs.map((r) => {
      const ride = rideMap[String(r.rideId)];
      return {
        _id: r._id, status: r.status, message: r.message,
        paymentStatus: r.paymentStatus || "none",
        amountPaid: r.amountPaid || 0,
        bookingCode: r.bookingCode || "",
        // Where the rider boards / drops and how many seats they booked.
        boardingPoint: r.boardingPoint || (ride ? ride.from : ""),
        droppingPoint: r.droppingPoint || (ride ? ride.to : ""),
        seatsRequested: r.seatsRequested || 1,
        // Rider contact exposed to the owner only after the booking is
        // confirmed AND the rider has completed payment.
        rider: {
          name: r.riderName, photo: r.riderPhoto, city: r.riderCity,
          phone: (r.status === "accepted" && r.paymentStatus === "paid") ? r.riderPhone : "",
        },
        ride: ride ? { _id: ride._id, from: ride.from, to: ride.to, date: ride.date, time: ride.time, status: rideStatusLabel(ride) } : null,
        createdAt: r.createdAt,
      };
    });
    return res.json({ success: true, count: data.length, data });
  } catch (err) {
    console.error("incomingRequests error:", err);
    return res.status(500).json({ success: false, message: "Server error while loading requests" });
  }
});

// GET /api/rides/requests/outgoing?phone=  — requests I SENT (rider)
router.get("/requests/outgoing", async (req, res) => {
  try {
    await sweepExpiredRides();
    await sweepExpiredRequests();
    const variants = phoneVariantsOf(req.query.phone);
    if (!variants.length) return res.status(400).json({ success: false, message: "phone is required" });
    // Hide unpaid holds — the rider only sees requests they actually paid & sent.
    const reqs = await RideRequest.find({
      riderPhone: { $in: variants },
      status: { $ne: "awaiting_payment" },
    }).sort({ createdAt: -1 }).lean();
    const rideIds = [...new Set(reqs.map((r) => String(r.rideId)))];
    const rides = await Ride.find({ _id: { $in: rideIds } }).lean();
    const rideMap = {}; rides.forEach((r) => { rideMap[String(r._id)] = r; });
    const data = [];
    for (const r of reqs) {
      const ride = rideMap[String(r.rideId)];
      let owner = null;
      let vehicle = null;
      if (r.status === "accepted" && ride) {
        const u = await findUserByPhone(ride.userPhone);
        // Driver profile (name/photo) and basic vehicle info (model/color/type)
        // are allowed at confirmation, but the CONTACT NUMBER and the VEHICLE
        // REGISTRATION NUMBER unlock ONLY after successful payment. This is the
        // authoritative backend gate — never send them before paid.
        const paid = r.paymentStatus === "paid";
        owner = {
          name: u?.fullName || "Vooggly Rider",
          photo: u?.photo || "",
          phone: paid ? ride.userPhone : "",
        };
        vehicle = {
          model: ride.vehicleModel || "",
          color: ride.vehicleColor || "",
          type: ride.vehicle || "",
          number: paid ? (ride.plateNumber || "") : "",
        };
      }
      data.push({
        _id: r._id, status: r.status,
        bookingCode: r.bookingCode || "",
        // Chosen boarding / dropping / seats for this booking.
        boardingPoint: r.boardingPoint || (ride ? ride.from : ""),
        droppingPoint: r.droppingPoint || (ride ? ride.to : ""),
        seatsRequested: r.seatsRequested || 1,
        // Payment state travels alongside booking state so the UI can show
        // "Pay Now" for a CONFIRMED-but-unpaid booking (independent of seats).
        paymentStatus: r.paymentStatus || "none",
        amountDue: r.amountDue || 0,
        amountPaid: r.amountPaid || 0,
        refundAmount: r.refundAmount || 0,
        refundReason: r.refundReason || "",
        requestExpiresAt: r.requestExpiresAt || null,
        ride: ride ? { _id: ride._id, from: ride.from, to: ride.to, date: ride.date, time: ride.time, vehicle: ride.vehicle || "", status: rideStatusLabel(ride) } : null,
        owner,
        vehicle,
        createdAt: r.createdAt,
      });
    }
    return res.json({ success: true, count: data.length, data });
  } catch (err) {
    console.error("outgoingRequests error:", err);
    return res.status(500).json({ success: false, message: "Server error while loading your requests" });
  }
});

// POST /api/rides/requests/:reqId/accept  { ownerPhone }
router.post("/requests/:reqId/accept", async (req, res) => {
  try {
    const reqDoc = await RideRequest.findById(req.params.reqId);
    if (!reqDoc) return res.status(404).json({ success: false, message: "Request not found" });
    if (!samePhone(reqDoc.posterPhone, req.body?.ownerPhone)) {
      return res.status(403).json({ success: false, message: "Not authorized" });
    }
    const ride = await Ride.findById(reqDoc.rideId);
    if (ride && isRideExpired(ride)) return res.status(400).json({ success: false, message: "Ride has expired or been closed" });
    if (reqDoc.status !== "pending") return res.status(400).json({ success: false, message: `Request already ${reqDoc.status}` });

    // Seat guard — never confirm more riders than the ride has seats. Only
    // CONFIRMED (accepted) requests occupy a seat; pending/rejected/cancelled
    // do not. This also settles the "multiple riders competing for the last
    // seat" case: the owner accepts them one at a time, and once the seats
    // are full every further accept is blocked here.
    const totalSeats = ride && typeof ride.seatsAvailable === "number" ? ride.seatsAvailable : 1;
    const confirmedSeats = await confirmedCountForRide(reqDoc.rideId);
    const wantSeats = Math.max(1, Number(reqDoc.seatsRequested) || 1);
    const seatsLeft = totalSeats - confirmedSeats;
    if (seatsLeft <= 0) {
      return res.status(409).json({
        success: false,
        message: "All seats for this ride are already filled. You can no longer accept this request.",
      });
    }
    if (wantSeats > seatsLeft) {
      return res.status(409).json({
        success: false,
        message: `This booking needs ${wantSeats} seat(s) but only ${seatsLeft} remain. You cannot accept it.`,
      });
    }

    // Atomic flip pending → accepted (guards against a double-click / race
    // confirming the same request twice).
    const updated = await RideRequest.findOneAndUpdate(
      { _id: reqDoc._id, status: "pending" },
      { $set: { status: "accepted", requestExpiresAt: null } }, // stop the auto-expiry clock
      { new: true }
    );
    if (!updated) {
      return res.status(400).json({ success: false, message: "This request has already been handled." });
    }
    notify(updated.riderPhone, "Ride Request Accepted",
      `Your request has been accepted. You can now view the permitted contact details for this confirmed ride.`,
      "/requests?tab=sent");
    sendSms(updated.riderPhone,
      `Vooggly: Your ride request was ACCEPTED. Open the app to view the driver's contact details.`);
    return res.json({ success: true, message: "Request accepted", data: updated });
  } catch (err) {
    console.error("acceptRequest error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// POST /api/rides/requests/:reqId/reject  { ownerPhone }
router.post("/requests/:reqId/reject", async (req, res) => {
  try {
    const reqDoc = await RideRequest.findById(req.params.reqId);
    if (!reqDoc) return res.status(404).json({ success: false, message: "Request not found" });
    if (!samePhone(reqDoc.posterPhone, req.body?.ownerPhone)) {
      return res.status(403).json({ success: false, message: "Not authorized" });
    }
    if (reqDoc.status !== "pending") return res.status(400).json({ success: false, message: `Request already ${reqDoc.status}` });
    reqDoc.status = "rejected";
    reqDoc.requestExpiresAt = null;
    await reqDoc.save();
    // Pay-first: a rejected request was already paid → auto-refund.
    await refundRequestPayment(reqDoc, "rejected");
    const ride = await Ride.findById(reqDoc.rideId);
    notify(reqDoc.riderPhone, "Ride Request Update",
      `Your request to join the ride was not accepted by the ride owner. Your payment has been refunded.`, "/requests?tab=sent");
    sendSms(reqDoc.riderPhone,
      `Vooggly: Your ride request was not accepted. Your payment has been refunded.`);
    return res.json({ success: true, message: "Request rejected and payment refunded", data: reqDoc });
  } catch (err) {
    console.error("rejectRequest error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// POST /api/rides/requests/:reqId/cancel  { riderPhone }  — rider cancels own
router.post("/requests/:reqId/cancel", async (req, res) => {
  try {
    const reqDoc = await RideRequest.findById(req.params.reqId);
    if (!reqDoc) return res.status(404).json({ success: false, message: "Request not found" });
    if (!samePhone(reqDoc.riderPhone, req.body?.riderPhone)) {
      return res.status(403).json({ success: false, message: "Not authorized" });
    }
    if (!["pending", "accepted"].includes(reqDoc.status)) {
      return res.status(400).json({ success: false, message: `Request already ${reqDoc.status}` });
    }
    // Refund only when cancelled BEFORE the owner accepted. Once accepted, the
    // booking is confirmed and contact was unlocked, so no auto-refund.
    const wasPendingUnaccepted = reqDoc.status === "pending";
    reqDoc.status = "cancelled";
    reqDoc.requestExpiresAt = null;
    await reqDoc.save();
    if (wasPendingUnaccepted) {
      await refundRequestPayment(reqDoc, "cancelled_by_rider");
    }
    const ride = await Ride.findById(reqDoc.rideId);
    notify(reqDoc.posterPhone, "Ride Request Cancelled",
      `A rider has cancelled their request to join your ride from ${ride?.from || ""} to ${ride?.to || ""}.`, "/requests");
    return res.json({ success: true, message: "Request cancelled", data: reqDoc });
  } catch (err) {
    console.error("cancelRequest error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// ============================================================
// BOOKING PAYMENT — charged to the RIDER only AFTER the driver confirms
// (status === "accepted"). Seat availability does NOT gate this: a confirmed
// rider can always pay even if the ride is now full. Amount = admin find-fee.
// ============================================================

// POST /api/rides/requests/:reqId/pay-order  { riderPhone }
// Creates (or safely re-returns) a Razorpay order for a confirmed booking.
// Idempotent: refresh / reopen returns the SAME pending order — no duplicates.
router.post("/requests/:reqId/pay-order", async (req, res) => {
  try {
    const reqDoc = await RideRequest.findById(req.params.reqId);
    if (!reqDoc) return res.status(404).json({ success: false, message: "Booking not found" });
    if (!samePhone(reqDoc.riderPhone, req.body?.riderPhone)) {
      return res.status(403).json({ success: false, message: "Not authorized" });
    }
    // Auth gate: only a real, verified account may start a payment.
    if (!(await requireVerifiedRider(req.body?.riderPhone, res))) return;
    if (reqDoc.status !== "accepted") {
      return res.status(400).json({ success: false, message: "Payment becomes available once the driver confirms your booking." });
    }
    // Already paid — nothing to do (refresh-safe).
    if (reqDoc.paymentStatus === "paid") {
      return res.json({ success: true, alreadyPaid: true, paymentStatus: "paid", bookingId: reqDoc._id, rideId: reqDoc.rideId });
    }

    const client = planCtrl.getRazorpayClient();
    if (!client) return res.status(500).json({ success: false, message: "Payment is temporarily unavailable. Please try again later." });

    const feeRupees = await planCtrl.loadBookingFee();
    const KEY = process.env.RAZORPAY_KEY_ID;

    // Reuse an existing pending order so a refresh/retry can't spawn duplicates.
    if (reqDoc.paymentOrderId) {
      try {
        const existing = await client.orders.fetch(reqDoc.paymentOrderId);
        if (existing && existing.status !== "paid") {
          return res.json({
            success: true,
            orderId: existing.id, key: KEY,
            amount: existing.amount, currency: existing.currency,
            amountRupees: existing.amount / 100,
            bookingId: reqDoc._id, rideId: reqDoc.rideId,
            paymentStatus: "pending",
          });
        }
      } catch (_e) { /* fall through and create a fresh order */ }
    }

    const order = await client.orders.create({
      amount: Math.round(feeRupees * 100),
      currency: "INR",
      receipt: "bk_" + String(reqDoc._id).slice(-16) + "_" + Date.now(),
      notes: { bookingId: String(reqDoc._id), rideId: String(reqDoc.rideId), riderPhone: reqDoc.riderPhone },
    });

    reqDoc.paymentOrderId = order.id;
    reqDoc.paymentStatus = "pending";
    reqDoc.amountDue = feeRupees;
    await reqDoc.save();

    return res.json({
      success: true,
      orderId: order.id, key: KEY,
      amount: order.amount, currency: order.currency,
      amountRupees: feeRupees,
      bookingId: reqDoc._id, rideId: reqDoc.rideId,
      paymentStatus: "pending",
    });
  } catch (err) {
    console.error("bookingPayOrder error:", err);
    return res.status(500).json({ success: false, message: "Could not start payment. Please try again." });
  }
});

// POST /api/rides/requests/:reqId/pay-verify
//   { riderPhone, razorpay_order_id, razorpay_payment_id, razorpay_signature }
// Verifies the Razorpay signature and marks the booking PAID. Idempotent.
router.post("/requests/:reqId/pay-verify", async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};
    const reqDoc = await RideRequest.findById(req.params.reqId);
    if (!reqDoc) return res.status(404).json({ success: false, message: "Booking not found" });
    if (!samePhone(reqDoc.riderPhone, req.body?.riderPhone)) {
      return res.status(403).json({ success: false, message: "Not authorized" });
    }
    // Auth gate: only a real, verified account may finalize a payment.
    if (!(await requireVerifiedRider(req.body?.riderPhone, res))) return;
    // Already verified — return success so a double-submit is harmless.
    if (reqDoc.paymentStatus === "paid") {
      return res.json({ success: true, alreadyPaid: true, paymentStatus: "paid" });
    }
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ success: false, message: "Missing payment confirmation details" });
    }

    const expected = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(razorpay_order_id + "|" + razorpay_payment_id)
      .digest("hex");
    if (expected !== razorpay_signature) {
      reqDoc.paymentStatus = "failed";
      await reqDoc.save();
      return res.status(401).json({ success: false, message: "Payment could not be verified. If money was deducted, it will be auto-refunded." });
    }

    let amountPaid = reqDoc.amountDue || 0;
    try {
      const client = planCtrl.getRazorpayClient();
      if (client) {
        const o = await client.orders.fetch(razorpay_order_id);
        if (o && o.amount) amountPaid = o.amount / 100;
      }
    } catch (_e) { /* non-fatal */ }

    reqDoc.paymentStatus = "paid";
    reqDoc.paymentId = razorpay_payment_id;
    reqDoc.amountPaid = amountPaid;
    reqDoc.paidAt = new Date();
    await reqDoc.save();

    const ride = await Ride.findById(reqDoc.rideId).lean();
    notify(reqDoc.riderPhone, "Payment Successful",
      `Your payment for the ride${ride ? ` from ${ride.from} to ${ride.to}` : ""} is complete. Your booking is confirmed.`,
      "/requests?tab=sent");
    notify(reqDoc.posterPhone, "Booking Payment Received",
      `A confirmed passenger has completed their payment${ride ? ` for your ride from ${ride.from} to ${ride.to}` : ""}.`,
      "/requests");

    return res.json({ success: true, paymentStatus: "paid", data: { _id: reqDoc._id, paymentStatus: "paid", amountPaid } });
  } catch (err) {
    console.error("bookingPayVerify error:", err);
    return res.status(500).json({ success: false, message: "Payment verification failed. Please try again." });
  }
});

// POST /api/rides/requests/mark-paid
//   { riderPhone, rideId, razorpay_order_id, razorpay_payment_id, razorpay_signature }
// Called by the existing find-ride payment page after its payment verifies.
// Marks the rider's CONFIRMED booking for this ride as PAID — which is what
// unlocks the contact number. The Razorpay signature is re-verified here so a
// booking can only be flipped to paid with a genuine payment proof.
router.post("/requests/mark-paid", async (req, res) => {
  try {
    const { rideId, razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};
    const variants = phoneVariantsOf(req.body?.riderPhone);
    if (!variants.length || !rideId) {
      return res.status(400).json({ success: false, message: "Missing booking details" });
    }
    // Auth gate: only a real, verified account may finalize a payment.
    if (!(await requireVerifiedRider(req.body?.riderPhone, res))) return;
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ success: false, message: "Missing payment confirmation details" });
    }
    const expected = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(razorpay_order_id + "|" + razorpay_payment_id)
      .digest("hex");
    if (expected !== razorpay_signature) {
      return res.status(401).json({ success: false, message: "Payment could not be verified." });
    }

    const reqDoc = await RideRequest.findOne({
      rideId,
      riderPhone: { $in: variants },
      status: "accepted",
    });
    if (!reqDoc) {
      return res.status(404).json({ success: false, message: "No confirmed booking found for this ride." });
    }
    if (reqDoc.paymentStatus !== "paid") {
      reqDoc.paymentStatus = "paid";
      reqDoc.paymentId = razorpay_payment_id;
      reqDoc.paymentOrderId = reqDoc.paymentOrderId || razorpay_order_id;
      reqDoc.paidAt = new Date();
      await reqDoc.save();
      const ride = await Ride.findById(rideId).lean();
      notify(reqDoc.riderPhone, "Payment Successful",
        `Your payment is complete${ride ? ` for the ride from ${ride.from} to ${ride.to}` : ""}. The contact details are now available.`,
        "/requests?tab=sent");
    }
    return res.json({ success: true, paymentStatus: "paid", bookingId: reqDoc._id });
  } catch (err) {
    console.error("markBookingPaid error:", err);
    return res.status(500).json({ success: false, message: "Could not update payment status." });
  }
});

// POST /api/rides/:id/close  { ownerPhone, userId }  — owner closes ride; cascade
router.post("/:id/close", async (req, res) => {
  try {
    const ride = await Ride.findById(req.params.id);
    if (!ride) return res.status(404).json({ success: false, message: "Ride not found" });
    const user = await resolveUser({ userId: req.body?.userId, phone: req.body?.ownerPhone });
    const isOwner = (user && ride.userId && String(user._id) === String(ride.userId)) ||
                    samePhone(ride.userPhone, req.body?.ownerPhone || user?.phone);
    if (!isOwner) {
      return res.status(403).json({ success: false, message: "Not authorized" });
    }
    ride.status = "closed";
    await ride.save();

    if (ride.liveRideId) {
      await LiveRide.findByIdAndUpdate(ride.liveRideId, { status: "ended", endedAt: new Date() });
    } else {
      await LiveRide.updateMany({ rideId: ride._id, status: "live" }, { status: "ended", endedAt: new Date() });
    }

    const pend = await RideRequest.find({ rideId: ride._id, status: { $in: ["pending", "accepted"] } });
    for (const r of pend) {
      r.status = "cancelled";
      await r.save();
      if (r.paymentStatus === "paid") {
        await refundRequestPayment(r, "ride_closed_by_owner");
      }
      notify(r.riderPhone, "Ride Closed",
        `The ride from ${ride.from} to ${ride.to} has been closed by the owner. Your request has been cancelled.`, "");
    }
    return res.json({ success: true, message: "Ride closed", data: { _id: ride._id, status: "closed" } });
  } catch (err) {
    console.error("closeRide error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// POST /api/rides/:id/complete  { ownerPhone, userId } — owner marks ride completed
router.post("/:id/complete", async (req, res) => {
  try {
    const ride = await Ride.findById(req.params.id);
    if (!ride) return res.status(404).json({ success: false, message: "Ride not found" });
    const user = await resolveUser({ userId: req.body?.userId, phone: req.body?.ownerPhone });
    const isOwner = (user && ride.userId && String(user._id) === String(ride.userId)) ||
                    samePhone(ride.userPhone, req.body?.ownerPhone || user?.phone);
    if (!isOwner) {
      return res.status(403).json({ success: false, message: "Only the ride creator can complete this ride" });
    }
    ride.status = "completed";
    await ride.save();

    if (ride.liveRideId) {
      await LiveRide.findByIdAndUpdate(ride.liveRideId, { status: "completed", endedAt: new Date() });
    } else {
      await LiveRide.updateMany({ rideId: ride._id, status: "live" }, { status: "completed", endedAt: new Date() });
    }

    const accepted = await RideRequest.find({ rideId: ride._id, status: "accepted" });
    for (const r of accepted) {
      notify(
        r.riderPhone,
        "Ride Completed",
        `Your ride from ${ride.from} to ${ride.to} has been completed. Thank you for travelling with Vooggly!`,
        "/profile-settings"
      );
    }

    return res.json({ success: true, message: "Ride marked as completed", data: { _id: ride._id, status: "completed" } });
  } catch (err) {
    console.error("completeRide error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// POST /api/rides/:id/cancel  { ownerPhone, userId, reason? } — owner cancels ride
router.post("/:id/cancel", async (req, res) => {
  try {
    const ride = await Ride.findById(req.params.id);
    if (!ride) return res.status(404).json({ success: false, message: "Ride not found" });
    const user = await resolveUser({ userId: req.body?.userId, phone: req.body?.ownerPhone });
    const isOwner = (user && ride.userId && String(user._id) === String(ride.userId)) ||
                    samePhone(ride.userPhone, req.body?.ownerPhone || user?.phone);
    if (!isOwner) {
      return res.status(403).json({ success: false, message: "Only the ride creator can cancel this ride" });
    }
    ride.status = "cancelled";
    await ride.save();

    if (ride.liveRideId) {
      await LiveRide.findByIdAndUpdate(ride.liveRideId, { status: "cancelled", endedAt: new Date() });
    } else {
      await LiveRide.updateMany({ rideId: ride._id, status: "live" }, { status: "cancelled", endedAt: new Date() });
    }

    const activeRequests = await RideRequest.find({ rideId: ride._id, status: { $in: ["pending", "accepted"] } });
    for (const r of activeRequests) {
      r.status = "cancelled";
      await r.save();
      if (r.paymentStatus === "paid") {
        await refundRequestPayment(r, "ride_cancelled_by_driver");
      }
      notify(
        r.riderPhone,
        "Ride Cancelled",
        `The ride from ${ride.from} to ${ride.to} has been cancelled by the driver. Any payments made have been refunded.`,
        "/profile-settings"
      );
    }

    return res.json({ success: true, message: "Ride cancelled successfully", data: { _id: ride._id, status: "cancelled" } });
  } catch (err) {
    console.error("cancelRide error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

router.getUserActiveRideStatus = getUserActiveRideStatus;
router.resolveUser = resolveUser;
router.phoneVariantsOf = phoneVariantsOf;
router.samePhone = samePhone;

module.exports = router;
