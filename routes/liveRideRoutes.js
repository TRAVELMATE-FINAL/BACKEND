// routes/liveRideRoutes.js
// Live Ride Sharing API. Mounted at /api/live-rides. Separate from posted-ride
// and booking workflows. Uses resilient HTTP polling for live location (no
// websockets) so it works on any host. Payment is verified server-side.

const express = require("express");
const crypto = require("crypto");
const router = express.Router();

const LiveRide = require("../models/LiveRide");
const User = require("../models/User");
const Notification = require("../models/Notification");
const planCtrl = require("../controllers/planController");

const normalizePhone = (raw) => {
  const digits = String(raw || "").replace(/\D/g, "");
  if (!digits) return "";
  const last10 = digits.slice(-10);
  return last10.length === 10 ? "+91" + last10 : String(raw || "").trim();
};
const samePhone = (a, b) => {
  const na = String(a || "").replace(/\D/g, "").slice(-10);
  const nb = String(b || "").replace(/\D/g, "").slice(-10);
  return na.length === 10 && na === nb;
};

async function findUser(phone) {
  const n = normalizePhone(phone);
  let u = await User.findOne({ phone: n });
  if (u) return u;
  const last10 = String(phone || "").replace(/\D/g, "").slice(-10);
  if (last10.length === 10) u = await User.findOne({ phone: { $regex: last10 + "$" } });
  return u;
}
// Auth gate: caller must be a real, verified, non-blocked member.
async function requireMember(phone, res) {
  const u = await findUser(phone);
  if (!u || !u.isVerified) {
    res.status(401).json({ success: false, code: "AUTH_REQUIRED", message: "Please log in to use live ride sharing." });
    return null;
  }
  if (u.isBlocked) {
    res.status(403).json({ success: false, blocked: true, message: "Your account has been blocked." });
    return null;
  }
  return u;
}

async function notify(userPhone, title, body, to) {
  try {
    if (!userPhone) return;
    await Notification.create({ userPhone, type: "info", title: title || "", body: body || "", action: { to: to || "" } });
  } catch {}
}

const confirmed = (ride) => (ride.passengers || []).filter((p) => p.status === "confirmed").length;

// Public-ish view of a ride for discovery (no private data).
function publicView(ride, viewerPhone) {
  const occ = confirmed(ride);
  const isHost = samePhone(ride.hostPhone, viewerPhone);
  const mine = (ride.passengers || []).find((p) => samePhone(p.phone, viewerPhone) && p.status === "confirmed");
  return {
    _id: ride._id,
    hostName: ride.hostName,
    vehicle: ride.vehicle,
    from: ride.from,
    to: ride.to,
    departureTime: ride.departureTime,
    totalSeats: ride.totalSeats,
    availableSeats: Math.max(0, ride.totalSeats - occ),
    farePerSeat: ride.farePerSeat,
    status: ride.status,
    startedAt: ride.startedAt,
    isHost,
    joined: !!mine,
    // Live location: shown to any verified member for discovery/preview.
    currentLat: ride.currentLat,
    currentLon: ride.currentLon,
    destLat: ride.destLat,
    destLon: ride.destLon,
    lastLocationAt: ride.lastLocationAt,
  };
}

// ── START a live ride (host) ───────────────────────────────────────────────
router.post("/", async (req, res) => {
  try {
    const hostPhone = normalizePhone(req.body?.hostPhone);
    const host = await requireMember(hostPhone, res);
    if (!host) return;

    const b = req.body || {};
    const totalSeats = Math.min(20, Math.max(1, parseInt(b.totalSeats, 10) || 0));
    const farePerSeat = Math.max(0, Math.round(Number(b.farePerSeat) || 0));
    if (!b.from || !b.to) return res.status(400).json({ success: false, message: "From and To are required." });
    if (!totalSeats) return res.status(400).json({ success: false, message: "Enter the number of seats." });

    // One active live ride per host at a time.
    const existing = await LiveRide.findOne({ hostPhone, status: "live" });
    if (existing) {
      return res.status(409).json({ success: false, message: "You already have a live ride running.", data: { _id: existing._id } });
    }

    const ride = await LiveRide.create({
      hostPhone,
      hostName: host.fullName || "",
      vehicle: {
        type: String(b.vehicleType || "Car").trim(),
        model: String(b.vehicleModel || "").trim(),
        color: String(b.vehicleColor || "").trim(),
        plate: String(b.plateNumber || "").trim(),
      },
      from: String(b.from).trim(),
      to: String(b.to).trim(),
      departureTime: String(b.departureTime || "").trim(),
      totalSeats,
      farePerSeat,
      currentLat: Number.isFinite(Number(b.lat)) ? Number(b.lat) : null,
      currentLon: Number.isFinite(Number(b.lon)) ? Number(b.lon) : null,
      destLat: Number.isFinite(Number(b.destLat)) ? Number(b.destLat) : null,
      destLon: Number.isFinite(Number(b.destLon)) ? Number(b.destLon) : null,
      lastLocationAt: (Number.isFinite(Number(b.lat)) && Number.isFinite(Number(b.lon))) ? new Date() : null,
      // Host occupies the first seat.
      passengers: [{
        phone: hostPhone, name: host.fullName || "", photo: host.photo || "",
        isHost: true, status: "confirmed", amountPaid: 0, joinedAt: new Date(),
      }],
    });

    return res.status(201).json({ success: true, data: publicView(ride, hostPhone) });
  } catch (err) {
    console.error("liveRide start error:", err.message);
    return res.status(500).json({ success: false, message: "Could not start live ride." });
  }
});

// ── HOST pushes latest GPS location ─────────────────────────────────────────
router.post("/:id/location", async (req, res) => {
  try {
    const phone = normalizePhone(req.body?.hostPhone);
    const lat = Number(req.body?.lat), lon = Number(req.body?.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return res.status(400).json({ success: false, message: "Valid lat/lon required." });
    }
    const ride = await LiveRide.findById(req.params.id);
    if (!ride) return res.status(404).json({ success: false, message: "Live ride not found." });
    if (!samePhone(ride.hostPhone, phone)) {
      return res.status(403).json({ success: false, message: "Only the host can update the location." });
    }
    if (ride.status !== "live") return res.status(400).json({ success: false, message: "This ride has ended." });
    ride.currentLat = lat; ride.currentLon = lon; ride.lastLocationAt = new Date();
    await ride.save();
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Location update failed." });
  }
});

// ── GET latest location (poll) — any verified member ───────────────────────
router.get("/:id/location", async (req, res) => {
  try {
    const member = await requireMember(req.query.phone, res);
    if (!member) return;
    const ride = await LiveRide.findById(req.params.id).lean();
    if (!ride) return res.status(404).json({ success: false, message: "Live ride not found." });
    return res.json({
      success: true,
      data: {
        lat: ride.currentLat, lon: ride.currentLon,
        destLat: ride.destLat, destLon: ride.destLon,
        lastLocationAt: ride.lastLocationAt,
        status: ride.status,
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Could not load location." });
  }
});

// ── LIST active live rides (discovery) ─────────────────────────────────────
router.get("/", async (req, res) => {
  try {
    const member = await requireMember(req.query.phone, res);
    if (!member) return;
    const rides = await LiveRide.find({ status: "live" }).sort({ startedAt: -1 }).limit(100);
    const viewer = normalizePhone(req.query.phone);
    return res.json({ success: true, data: rides.map((r) => publicView(r, viewer)) });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Could not load live rides." });
  }
});

// ── DETAIL ─────────────────────────────────────────────────────────────────
router.get("/:id", async (req, res) => {
  try {
    const member = await requireMember(req.query.phone, res);
    if (!member) return;
    const ride = await LiveRide.findById(req.params.id);
    if (!ride) return res.status(404).json({ success: false, message: "Live ride not found." });
    return res.json({ success: true, data: publicView(ride, normalizePhone(req.query.phone)) });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Could not load the ride." });
  }
});

// ── JOIN: create Razorpay order for a seat ─────────────────────────────────
router.post("/:id/join-order", async (req, res) => {
  try {
    const riderPhone = normalizePhone(req.body?.riderPhone);
    const member = await requireMember(riderPhone, res);
    if (!member) return;
    const ride = await LiveRide.findById(req.params.id);
    if (!ride || ride.status !== "live") return res.status(404).json({ success: false, message: "This live ride is no longer available." });
    if (samePhone(ride.hostPhone, riderPhone)) return res.status(400).json({ success: false, message: "You are the host of this ride." });

    const already = (ride.passengers || []).find((p) => samePhone(p.phone, riderPhone) && p.status === "confirmed");
    if (already) return res.status(409).json({ success: false, message: "You have already joined this ride." });

    if (confirmed(ride) >= ride.totalSeats) {
      return res.status(409).json({ success: false, message: "This ride is full — no seats available." });
    }

    const amountPaise = Math.round(Number(ride.farePerSeat) * 100);
    if (!(amountPaise > 0)) return res.status(400).json({ success: false, message: "This ride has no sharing fee set." });

    const client = planCtrl.getRazorpayClient();
    if (!client) return res.status(500).json({ success: false, message: "Payment is temporarily unavailable." });
    const KEY = process.env.RAZORPAY_KEY_ID;

    // Reuse/replace this rider's pending entry.
    let p = (ride.passengers || []).find((x) => samePhone(x.phone, riderPhone));
    let order = null;
    if (p && p.paymentOrderId) {
      try { const ex = await client.orders.fetch(p.paymentOrderId); if (ex && ex.status !== "paid") order = ex; } catch {}
    }
    if (!order) {
      order = await client.orders.create({
        amount: amountPaise, currency: "INR",
        receipt: `live_${ride._id}_${riderPhone.slice(-10)}`,
        notes: { liveRideId: String(ride._id), riderPhone, purpose: "live_ride_join" },
      });
    }
    if (p) { p.status = "pending"; p.paymentOrderId = order.id; p.name = member.fullName || p.name; }
    else {
      ride.passengers.push({
        phone: riderPhone, name: member.fullName || "", photo: member.photo || "",
        isHost: false, status: "pending", paymentOrderId: order.id,
      });
    }
    await ride.save();

    return res.json({
      success: true, orderId: order.id, amount: order.amount, amountRupees: ride.farePerSeat,
      currency: order.currency || "INR", key: KEY, liveRideId: ride._id,
    });
  } catch (err) {
    console.error("liveRide join-order error:", err.message);
    return res.status(500).json({ success: false, message: "Could not start payment." });
  }
});

// ── JOIN: verify payment → confirm seat (anti-overbook) ────────────────────
router.post("/:id/join-verify", async (req, res) => {
  try {
    const riderPhone = normalizePhone(req.body?.riderPhone);
    const member = await requireMember(riderPhone, res);
    if (!member) return;
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};

    const ride = await LiveRide.findById(req.params.id);
    if (!ride) return res.status(404).json({ success: false, message: "Live ride not found." });

    const p = (ride.passengers || []).find((x) => samePhone(x.phone, riderPhone));
    if (p && p.status === "confirmed") return res.json({ success: true, alreadyJoined: true, data: publicView(ride, riderPhone) });

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ success: false, message: "Missing payment details." });
    }
    const expected = crypto.createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(razorpay_order_id + "|" + razorpay_payment_id).digest("hex");
    if (expected !== razorpay_signature) {
      return res.status(401).json({ success: false, message: "Payment could not be verified." });
    }

    // Seats may have filled while paying → refund, don't confirm.
    if (ride.status !== "live" || confirmed(ride) >= ride.totalSeats) {
      try {
        const client = planCtrl.getRazorpayClient();
        if (client) await client.payments.refund(razorpay_payment_id, { amount: Math.round(Number(ride.farePerSeat) * 100), speed: "normal", notes: { reason: "live_ride_full" } });
      } catch {}
      if (p) { p.status = "refunded"; await ride.save(); }
      return res.status(409).json({ success: false, refunded: true, message: "The ride just became full. Your payment has been refunded." });
    }

    if (p) {
      p.status = "confirmed"; p.paymentId = razorpay_payment_id;
      p.amountPaid = ride.farePerSeat; p.joinedAt = new Date();
    } else {
      ride.passengers.push({
        phone: riderPhone, name: member.fullName || "", photo: member.photo || "",
        isHost: false, status: "confirmed", paymentId: razorpay_payment_id, amountPaid: ride.farePerSeat, joinedAt: new Date(),
      });
    }
    await ride.save();

    notify(ride.hostPhone, "New co-passenger", `${member.fullName || "A member"} joined your live ride ${ride.from} → ${ride.to}.`, "/live-rides");
    return res.json({ success: true, data: publicView(ride, riderPhone) });
  } catch (err) {
    console.error("liveRide join-verify error:", err.message);
    return res.status(500).json({ success: false, message: "Could not confirm your seat." });
  }
});

// ── STOP / end the ride (host) ─────────────────────────────────────────────
router.post("/:id/stop", async (req, res) => {
  try {
    const phone = normalizePhone(req.body?.hostPhone);
    const ride = await LiveRide.findById(req.params.id);
    if (!ride) return res.status(404).json({ success: false, message: "Live ride not found." });
    if (!samePhone(ride.hostPhone, phone)) return res.status(403).json({ success: false, message: "Only the host can stop this ride." });
    if (ride.status === "ended") return res.json({ success: true, data: publicView(ride, phone) });
    ride.status = "ended"; ride.endedAt = new Date();
    await ride.save();
    (ride.passengers || []).forEach((p) => {
      if (!p.isHost && p.status === "confirmed") {
        notify(p.phone, "Live ride ended", `Your live ride ${ride.from} → ${ride.to} has ended.`, "/live-rides");
      }
    });
    return res.json({ success: true, data: publicView(ride, phone) });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Could not stop the ride." });
  }
});

module.exports = router;
