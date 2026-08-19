// routes/rideRoutes.js
// All ride endpoints + handler logic in a single file (CommonJS).
// PostRide / FindFriends / Connect-Unlock APIs.

const express = require("express");
const router = express.Router();

const Ride = require("../models/Ride");
const User = require("../models/User");
const Booking = require("../models/Booking");
const Notification = require("../models/Notification");
const RideRequest = require("../models/RideRequest");

// ============================================================
// HELPERS
// ============================================================

// ── Expiry helpers ──────────────────────────────────────────
// A ride is expired once its date+time has passed, OR it's been
// closed/expired explicitly. Enforced on the backend for search + direct
// access so old posts can never be returned or requested.
function rideDateTime(ride) {
  if (!ride || !ride.date) return null;
  const t = ride.time && /^\d{1,2}:\d{2}$/.test(ride.time) ? ride.time : "23:59";
  const dt = new Date(`${ride.date}T${t}:00`);
  return isNaN(dt.getTime()) ? null : dt;
}
function isRideExpired(ride) {
  if (!ride) return true;
  if (ride.status === "closed" || ride.status === "expired") return true;
  const dt = rideDateTime(ride);
  if (!dt) return false; // no parseable datetime → don't hide it
  return dt.getTime() < Date.now();
}
function rideStatusLabel(ride) {
  if (ride.status === "closed") return "closed";
  if (ride.status === "expired" || isRideExpired(ride)) return "expired";
  return "active";
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

// Strip contact info (phone numbers, emails) from public-facing notes so a
// number typed into "Notes & preferences" is never exposed publicly. Contact
// is only shared after an accepted Request to Ride.
function sanitizeNotes(text) {
  if (!text) return "";
  let out = String(text);
  out = out.replace(/\+?\d[\d\s\-().]{7,}\d/g, "[contact hidden]"); // phone-like
  out = out.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[contact hidden]"); // emails
  return out.replace(/\s{2,}/g, " ").trim();
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
        await RideRequest.updateOne({ _id: req._id }, { $set: { status: "expired" } });
        notify(req.riderPhone, "Ride Expired",
          `The ride from ${r.from} to ${r.to} has reached its scheduled time and is no longer available. Your request has been closed.`, "");
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

// ============================================================
// POST /api/rides — create a new ride
// ============================================================
router.post("/", async (req, res) => {
  try {
    const {
      from, to, date, time, gender, distance, duration,
      fromLat, fromLon, toLat, toLon,
      userPhone, vehicle, vehicleModel, vehicleColor, plateNumber,
      seatsAvailable, additionalInfo,
    } = req.body;

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
      userPhone: normalizedUserPhone,
      vehicle: vehicle || "Bike",
      vehicleModel: vehicleModel || "",
      vehicleColor: vehicleColor || "",
      plateNumber:  plateNumber  || "",
      seatsAvailable: typeof seatsAvailable === "number" ? seatsAvailable : 1,
      additionalInfo: additionalInfo || "",
    });

    return res.status(201).json({
      success: true,
      message: "Ride posted successfully",
      data: ride,
    });
  } catch (err) {
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

// Count confirmed requests for a single ride.
async function confirmedCountForRide(rideId) {
  return RideRequest.countDocuments({ rideId, status: CONFIRMED_STATUS });
}

// Batch: Map<rideId(string), confirmedCount> for a list of rides.
async function confirmedCountsFor(rideIds) {
  if (!rideIds || !rideIds.length) return new Map();
  const rows = await RideRequest.aggregate([
    { $match: { rideId: { $in: rideIds }, status: CONFIRMED_STATUS } },
    { $group: { _id: "$rideId", n: { $sum: 1 } } },
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
    const user = await findUserByPhone(r.userPhone);
    const obj = r.toObject ? r.toObject() : r;
    obj.driverName = user?.fullName?.trim() || "TravelMate Rider";
    obj.driverPhoto = user?.photo || "";
    obj.driverCity = user?.city || "";
    // Never expose a phone/email typed into notes in public ride lists.
    obj.additionalInfo = sanitizeNotes(obj.additionalInfo);
    // Seat availability based on CONFIRMED requests only.
    attachSeatInfo(obj, counts.get(String(r._id)) || 0);
    out.push(obj);
  }
  return out;
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
    const RADIUS_KM = num(process.env.NEARBY_RADIUS_KM) || 15;

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
      const dbq = {};
      if (genderT) dbq.gender = { $regex: `^${escapeRx(genderT)}$`, $options: "i" };
      candidates = await Ride.find(dbq).sort({ createdAt: -1 });
    } else {
      const fieldMatch = (field, term) => {
        const ors = [{ [field]: { $regex: escapeRx(term), $options: "i" } }];
        tokensOf(term).forEach((t) =>
          ors.push({ [field]: { $regex: escapeRx(t), $options: "i" } })
        );
        return { $or: ors };
      };
      const and = [];
      if (fromT)   and.push(fieldMatch("from", fromT));
      if (toT)     and.push(fieldMatch("to", toT));
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

    const scored = [];
    for (const r of candidates) {
      const fromR = evalField(fromT, fLat, fLon, hasFromGeo, r.fromLat, r.fromLon, r.from);
      const toR   = evalField(toT,   tLat, tLon, hasToGeo,   r.toLat,   r.toLon,   r.to);
      if (!fromR.pass || !toR.pass) continue;

      const dist =
        (Number.isFinite(fromR.dist) ? fromR.dist : 0) +
        (Number.isFinite(toR.dist) ? toR.dist : 0);
      const exactScore = (fromR.exact ? 1 : 0) + (toR.exact ? 1 : 0);
      scored.push({ ride: r, dist, exactScore });
    }

    // Prioritise exact matches, then nearest by combined distance.
    scored.sort((a, b) => (b.exactScore - a.exactScore) || (a.dist - b.dist));
    const rides = scored.map((s) => s.ride);

    if (rides.length === 0) {
      return res.status(200).json({
        success: true,
        count: 0,
        message: "Ride not available",
        data: [],
      });
    }

    const enriched = await enrichRidesWithUser(rides);
    return res.status(200).json({ success: true, count: enriched.length, data: enriched });
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

    console.log(
      `[connect] rideId=${id} userPhone="${ride.userPhone}" → user=${user?.fullName || "(not found)"}`
    );

    const driverName = user?.fullName?.trim() || "TravelMate Rider";
    const driverPhone = ride.userPhone || "";

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
          vehicle: ride.vehicle || "Bike",
          vehicleModel: ride.vehicleModel || "",
          vehicleColor: ride.vehicleColor || "",
          plateNumber: ride.plateNumber || "",
          seatsAvailable: totalSeats,
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
          photo: user?.photo || "",
          city: user?.city || "",
          // Contact is NOT exposed here — revealed only after the ride owner
          // accepts the rider's request (see the /requests endpoints).
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
    console.log(
      `[details] rideId=${id} userPhone="${ride.userPhone}" → ` +
      `user=${user ? user.fullName || "(no fullName)" : "(not found)"}`
    );

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
          vehicle: ride.vehicle || "Bike",
          vehicleModel: ride.vehicleModel || "",
          vehicleColor: ride.vehicleColor || "",
          plateNumber: ride.plateNumber || "",
          seatsAvailable: totalSeats,
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
          fullName: user?.fullName?.trim() || "TravelMate Rider",
          photo: user?.photo || "",
          city: user?.city || "",
          email: user?.email || "",
          // Both forms — frontend can pick. RideDetail shows the
          // unmasked phone since the user has already paid by the
          // time they land on that page.
          // Contact is NOT exposed publicly — revealed only after the ride
          // owner accepts the rider's request (see the /requests endpoints).
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

    return res.status(200).json({
      success: true,
      message: "Contact unlocked",
      data: { phone: ride.userPhone },
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
      "date", "time", "seatsAvailable", "gender",
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
        } else if (k === "plateNumber") {
          ride[k] = String(req.body[k] || "").toUpperCase().replace(/[\s-]/g, "");
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
const phoneVariantsOf = (raw) => {
  const s = String(raw || "").trim();
  const last10 = s.replace(/\D/g, "").slice(-10);
  const list = s ? [s] : [];
  if (last10.length === 10) list.push("+91" + last10, "91" + last10, last10);
  return [...new Set(list)];
};
const samePhone = (a, b) =>
  phoneVariantsOf(a).some((v) => phoneVariantsOf(b).includes(v));

// POST /api/rides/:id/request  { riderPhone, message? }
router.post("/:id/request", async (req, res) => {
  try {
    const riderPhone = normalizePhone(req.body?.riderPhone || "");
    const message = String(req.body?.message || "").slice(0, 300);
    if (!riderPhone) return res.status(400).json({ success: false, message: "Rider phone is required" });

    const ride = await Ride.findById(req.params.id);
    if (!ride) return res.status(404).json({ success: false, message: "Ride not found" });
    if (isRideExpired(ride)) return res.status(400).json({ success: false, message: "This ride has expired or been closed" });
    if (samePhone(ride.userPhone, riderPhone)) {
      return res.status(400).json({ success: false, message: "You can't request your own ride" });
    }

    const rider = await findUserByPhone(riderPhone);
    let reqDoc = await RideRequest.findOne({ rideId: ride._id, riderPhone });
    if (reqDoc && (reqDoc.status === "pending" || reqDoc.status === "accepted")) {
      return res.status(409).json({ success: false, message: "You have already requested this ride", data: reqDoc });
    }

    // Seat guard — a ride with no remaining seats (all confirmed) can't take
    // new requests. Only CONFIRMED (accepted) requests occupy a seat.
    const totalSeats = typeof ride.seatsAvailable === "number" ? ride.seatsAvailable : 1;
    const confirmedSeats = await confirmedCountForRide(ride._id);
    if (confirmedSeats >= totalSeats) {
      return res.status(409).json({ success: false, message: "This ride is full — no seats are available." });
    }
    const snap = {
      posterPhone: ride.userPhone,
      riderPhone,
      riderName: rider?.fullName || "",
      riderPhoto: rider?.photo || "",
      riderCity: rider?.city || "",
      message,
      status: "pending",
    };
    if (reqDoc) { Object.assign(reqDoc, snap); await reqDoc.save(); }
    else { reqDoc = await RideRequest.create({ rideId: ride._id, ...snap }); }

    notify(ride.userPhone, "New Ride Request",
      `A user has requested to join your ride from ${ride.from} to ${ride.to}. Please review the request and choose Accept or Reject.`, "/requests");

    return res.status(201).json({ success: true, message: "Request sent", data: reqDoc });
  } catch (err) {
    if (err && err.code === 11000) {
      return res.status(409).json({ success: false, message: "You have already requested this ride" });
    }
    console.error("createRideRequest error:", err);
    return res.status(500).json({ success: false, message: "Server error while sending request" });
  }
});

// GET /api/rides/requests/incoming?phone=  — requests for MY rides (owner)
router.get("/requests/incoming", async (req, res) => {
  try {
    await sweepExpiredRides();
    const variants = phoneVariantsOf(req.query.phone);
    if (!variants.length) return res.status(400).json({ success: false, message: "phone is required" });
    const reqs = await RideRequest.find({ posterPhone: { $in: variants } }).sort({ createdAt: -1 }).lean();
    const rideIds = [...new Set(reqs.map((r) => String(r.rideId)))];
    const rides = await Ride.find({ _id: { $in: rideIds } }).lean();
    const rideMap = {}; rides.forEach((r) => { rideMap[String(r._id)] = r; });
    const data = reqs.map((r) => {
      const ride = rideMap[String(r.rideId)];
      return {
        _id: r._id, status: r.status, message: r.message,
        // Rider contact only exposed to the owner once accepted.
        rider: {
          name: r.riderName, photo: r.riderPhoto, city: r.riderCity,
          phone: r.status === "accepted" ? r.riderPhone : "",
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
    const variants = phoneVariantsOf(req.query.phone);
    if (!variants.length) return res.status(400).json({ success: false, message: "phone is required" });
    const reqs = await RideRequest.find({ riderPhone: { $in: variants } }).sort({ createdAt: -1 }).lean();
    const rideIds = [...new Set(reqs.map((r) => String(r.rideId)))];
    const rides = await Ride.find({ _id: { $in: rideIds } }).lean();
    const rideMap = {}; rides.forEach((r) => { rideMap[String(r._id)] = r; });
    const data = [];
    for (const r of reqs) {
      const ride = rideMap[String(r.rideId)];
      let owner = null;
      if (r.status === "accepted" && ride) {
        const u = await findUserByPhone(ride.userPhone);
        // Contact revealed to the rider only after acceptance.
        owner = { name: u?.fullName || "TravelMate Rider", phone: ride.userPhone, photo: u?.photo || "" };
      }
      data.push({
        _id: r._id, status: r.status,
        ride: ride ? { _id: ride._id, from: ride.from, to: ride.to, date: ride.date, time: ride.time, vehicle: ride.vehicle || "", status: rideStatusLabel(ride) } : null,
        owner,
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
    if (confirmedSeats >= totalSeats) {
      return res.status(409).json({
        success: false,
        message: "All seats for this ride are already filled. You can no longer accept this request.",
      });
    }

    // Atomic flip pending → accepted (guards against a double-click / race
    // confirming the same request twice).
    const updated = await RideRequest.findOneAndUpdate(
      { _id: reqDoc._id, status: "pending" },
      { $set: { status: "accepted" } },
      { new: true }
    );
    if (!updated) {
      return res.status(400).json({ success: false, message: "This request has already been handled." });
    }
    notify(updated.riderPhone, "Ride Request Accepted",
      `Your request has been accepted. You can now view the permitted contact details for this confirmed ride.`,
      "/requests");
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
    await reqDoc.save();
    const ride = await Ride.findById(reqDoc.rideId);
    notify(reqDoc.riderPhone, "Ride Request Update",
      `Your request to join the ride was not accepted by the ride owner.`, "/requests");
    return res.json({ success: true, message: "Request rejected", data: reqDoc });
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
    reqDoc.status = "cancelled";
    await reqDoc.save();
    const ride = await Ride.findById(reqDoc.rideId);
    notify(reqDoc.posterPhone, "Ride Request Cancelled",
      `A rider has cancelled their request to join your ride from ${ride?.from || ""} to ${ride?.to || ""}.`, "/requests");
    return res.json({ success: true, message: "Request cancelled", data: reqDoc });
  } catch (err) {
    console.error("cancelRequest error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// POST /api/rides/:id/close  { ownerPhone }  — owner closes ride; cascade
router.post("/:id/close", async (req, res) => {
  try {
    const ride = await Ride.findById(req.params.id);
    if (!ride) return res.status(404).json({ success: false, message: "Ride not found" });
    if (!samePhone(ride.userPhone, req.body?.ownerPhone)) {
      return res.status(403).json({ success: false, message: "Not authorized" });
    }
    ride.status = "closed";
    await ride.save();
    const pend = await RideRequest.find({ rideId: ride._id, status: { $in: ["pending", "accepted"] } });
    for (const r of pend) {
      r.status = "cancelled";
      await r.save();
      notify(r.riderPhone, "Ride Closed",
        `The ride from ${ride.from} to ${ride.to} has been closed by the owner. Your request has been cancelled.`, "");
    }
    return res.json({ success: true, message: "Ride closed", data: { _id: ride._id, status: "closed" } });
  } catch (err) {
    console.error("closeRide error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

module.exports = router;
