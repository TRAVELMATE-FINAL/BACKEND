// routes/rideRoutes.js
// All ride endpoints + handler logic in a single file (CommonJS).
// PostRide / FindFriends / Connect-Unlock APIs.

const express = require("express");
const router = express.Router();

const Ride = require("../models/Ride");
const User = require("../models/User");

// ============================================================
// HELPERS
// ============================================================

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
const enrichRidesWithUser = async (rides) => {
  const out = [];
  for (const r of rides) {
    const user = await findUserByPhone(r.userPhone);
    const obj = r.toObject ? r.toObject() : r;
    obj.driverName = user?.fullName?.trim() || "TravelMate Rider";
    obj.driverPhoto = user?.photo || "";
    obj.driverCity = user?.city || "";
    out.push(obj);
  }
  return out;
};

// ============================================================
// GET /api/rides — all rides, newest first (FindFriends)
// ============================================================
router.get("/", async (req, res) => {
  try {
    const rides = await Ride.find().sort({ createdAt: -1 });
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
          additionalInfo: r.additionalInfo || "",
          viewCount: r.viewCount || 0,
          createdAt: r.createdAt,
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
    const { from, to, date, gender } = req.query;

    // Trim everything once
    const fromT   = (from   || "").trim();
    const toT     = (to     || "").trim();
    const dateT   = (date   || "").trim();
    const genderT = (gender || "").trim();

    if (!fromT && !toT && !dateT && !genderT) {
      return res.status(400).json({
        success: false,
        error: "Provide at least one filter (from, to, date or gender)",
        message: "Provide at least one filter (from, to, date or gender)",
      });
    }

    // Escape regex special chars so city names like "Pondicherry (UT)"
    // don't break the query.
    const escapeRx = (s) =>
      String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    const query = {};
    if (fromT)   query.from   = { $regex: escapeRx(fromT), $options: "i" };
    if (toT)     query.to     = { $regex: escapeRx(toT),   $options: "i" };
    if (dateT)   query.date   = dateT;
    if (genderT) query.gender = { $regex: `^${escapeRx(genderT)}$`, $options: "i" };

    const rides = await Ride.find(query).sort({ createdAt: -1 });

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

    Ride.updateOne({ _id: id }, { $inc: { viewCount: 1 } }).catch(() => {});

    const user = await findUserByPhone(ride.userPhone);

    console.log(
      `[connect] rideId=${id} userPhone="${ride.userPhone}" → user=${user?.fullName || "(not found)"}`
    );

    const driverName = user?.fullName?.trim() || "TravelMate Rider";
    const driverPhone = ride.userPhone || "";

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
          seatsAvailable: typeof ride.seatsAvailable === "number" ? ride.seatsAvailable : 1,
          additionalInfo: ride.additionalInfo || "",
          viewCount: (ride.viewCount || 0) + 1,
          createdAt: ride.createdAt,
        },
        user: {
          fullName: driverName,
          photo: user?.photo || "",
          city: user?.city || "",
          maskedPhone: maskPhone(driverPhone),
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
    const [totalPostedRides, upcomingRides] = await Promise.all([
      driverPhone ? Ride.countDocuments(phoneClause) : Promise.resolve(0),
      driverPhone
        ? Ride.countDocuments({ ...phoneClause, date: { $gte: todayISOStr } })
        : Promise.resolve(0),
    ]);

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
          seatsAvailable: typeof ride.seatsAvailable === "number" ? ride.seatsAvailable : 1,
          additionalInfo: ride.additionalInfo || "",
          viewCount: ride.viewCount || 0,
          createdAt: ride.createdAt,
        },
        driver: {
          fullName: user?.fullName?.trim() || "TravelMate Rider",
          photo: user?.photo || "",
          city: user?.city || "",
          email: user?.email || "",
          // Both forms — frontend can pick. RideDetail shows the
          // unmasked phone since the user has already paid by the
          // time they land on that page.
          phone: driverPhone,
          maskedPhone: maskPhone(driverPhone),
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

module.exports = router;
