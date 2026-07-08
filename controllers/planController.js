// controllers/planController.js
const crypto = require("crypto");
const Razorpay = require("razorpay");
const Subscription = require("../models/Subscription");
const Coupon = require("../models/Coupon");
const Setting = require("../models/Setting");

// ── Static plan metadata (labels only — prices/durations come from the DB) ──
const PLAN_META = {
  daily:   { name: "Daily Plan",   sub: "Short-term Access", feature: "Unlimited Post Any Route For 24 Hours" },
  monthly: { name: "Monthly Plan", sub: "High Engagement",   feature: "Unlimited Post Any Route For 1 Month" },
  yearly:  { name: "Yearly Plan",  sub: "Ultimate Savings",  feature: "Unlimited Post Any Route For 1 Year" },
};

// ── Fallback prices/durations (used if the Setting doc is missing a value) ──
const DEFAULTS = {
  daily:   { price: 30,   durationDays: 1 },
  monthly: { price: 650,  durationDays: 30 },
  yearly:  { price: 1200, durationDays: 365 },
  findRide:{ unlockFee: 49, processingFee: 1 },
};

const num = (v, fallback) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : fallback);

// Load the live pricing document (admin-editable). Always reads the DB so a
// price change in the admin panel reflects on the website on the next request.
async function loadPricingDoc() {
  try {
    const doc = await Setting.findOne({ key: "pricing" }).lean();
    return doc || null;
  } catch (e) {
    return null;
  }
}

// Build the full plan catalog (labels + live price/duration) keyed by plan.
async function loadCatalog() {
  const doc = await loadPricingDoc();
  const p = (doc && doc.plans) || {};
  const build = (key) => ({
    ...PLAN_META[key],
    price: num(p[key] && p[key].price, DEFAULTS[key].price),
    durationDays: num(p[key] && p[key].durationDays, DEFAULTS[key].durationDays),
  });
  return { daily: build("daily"), monthly: build("monthly"), yearly: build("yearly") };
}

// Live find-ride (unlock) fees.
async function loadFindFee() {
  const doc = await loadPricingDoc();
  const f = (doc && doc.findRide) || {};
  return {
    unlockFee: num(f.unlockFee, DEFAULTS.findRide.unlockFee),
    processingFee: num(f.processingFee, DEFAULTS.findRide.processingFee),
  };
}

// ── Razorpay client (lazy) ──
let rzp = null;
const getRazorpay = () => {
  if (rzp) return rzp;
  if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) return null;
  rzp = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
  });
  return rzp;
};

// ── Phone normaliser (matches the User model format) ──
const normPhone = (raw = "") => {
  const clean = String(raw).replace(/\D/g, "");
  const ten = clean.length === 12 && clean.startsWith("91") ? clean.slice(2) : clean;
  if (!/^\d{10}$/.test(ten)) return "";
  return "+91" + ten;
};

// ===========================================================
// GET /api/plans  — the three plan cards for Chooseyourplan.
// ===========================================================
exports.getPlans = async (req, res) => {
  try {
    const catalog = await loadCatalog();
    const plans = Object.entries(catalog).map(([key, p]) => ({
      key,
      name: p.name,
      sub: p.sub,
      feature: p.feature,
      price: p.price,
      durationDays: p.durationDays,
    }));
    res.json({ plans });
  } catch (err) {
    console.error("getPlans error:", err);
    res.status(500).json({ message: err.message });
  }
};

// ===========================================================
// GET /api/plans/find-fee  — live unlock + processing fee.
// ===========================================================
exports.getFindFee = async (req, res) => {
  try {
    const fee = await loadFindFee();
    res.json(fee);
  } catch (err) {
    console.error("getFindFee error:", err);
    res.status(500).json({ message: err.message });
  }
};

// ===========================================================
// GET /api/plans/me?phone=+91...
// ===========================================================
exports.getMySubscription = async (req, res) => {
  try {
    const phone = normPhone(req.query.phone);
    if (!phone) return res.status(400).json({ message: "Valid phone is required" });

    const now = new Date();
    const sub = await Subscription.findOne({
      phone, status: "active", endDate: { $gt: now },
    }).sort({ endDate: -1 });

    if (!sub) {
      return res.json({ active: false, subscription: null, canPostRide: false });
    }

    const msLeft = sub.endDate - now;
    const daysLeft = Math.ceil(msLeft / (1000 * 60 * 60 * 24));
    res.json({
      active: true,
      canPostRide: true,
      subscription: {
        plan: sub.plan,
        startDate: sub.startDate,
        endDate: sub.endDate,
        daysLeft,
        amountPaid: sub.amountPaid,
      },
    });
  } catch (err) {
    console.error("getMySubscription error:", err);
    res.status(500).json({ message: err.message });
  }
};

// ===========================================================
// POST /api/plans/coupon/apply   Body: { code, plan }
// ===========================================================
exports.applyCoupon = async (req, res) => {
  try {
    const { code, plan } = req.body;
    if (!code || !plan) return res.status(400).json({ message: "code and plan are required" });
    const catalog = await loadCatalog();
    if (!catalog[plan]) return res.status(400).json({ message: "Invalid plan" });

    const coupon = await Coupon.findOne({ code: String(code).toUpperCase().trim() });
    if (!coupon) return res.status(404).json({ message: "Invalid coupon code" });

    const valid = coupon.isValidNow(plan);
    if (!valid.ok) return res.status(400).json({ message: valid.reason });

    const originalAmount = catalog[plan].price;
    const cashback = coupon.computeCashback(originalAmount);
    const finalAmount = Math.max(0, originalAmount - cashback);

    res.json({
      ok: true,
      code: coupon.code,
      type: coupon.type,
      value: coupon.value,
      originalAmount,
      cashback,
      finalAmount,
      expiresAt: coupon.expiresAt,
    });
  } catch (err) {
    console.error("applyCoupon error:", err);
    res.status(500).json({ message: err.message });
  }
};

// ===========================================================
// POST /api/plans/order   Body: { phone, plan, couponCode?, amount? }
// ===========================================================
exports.createOrder = async (req, res) => {
  try {
    const { plan, couponCode, amount: clientAmountPaise } = req.body;
    const phone = normPhone(req.body.phone);
    if (!phone) return res.status(400).json({ message: "Valid phone is required" });
    const catalog = await loadCatalog();
    if (!catalog[plan]) return res.status(400).json({ message: "Invalid plan" });

    const originalAmount = catalog[plan].price;
    let cashback = 0;
    let finalAmount = originalAmount;
    let coupon = null;

    if (couponCode) {
      coupon = await Coupon.findOne({ code: String(couponCode).toUpperCase().trim() });
      if (coupon) {
        const valid = coupon.isValidNow(plan);
        if (!valid.ok) return res.status(400).json({ message: valid.reason });
        cashback = coupon.computeCashback(originalAmount);
        finalAmount = Math.max(0, originalAmount - cashback);
      }
    }

    // Fixed-fee pages (UnlockContact) send an explicit amount in paise.
    if (clientAmountPaise && Number(clientAmountPaise) > 0) {
      finalAmount = Math.round(Number(clientAmountPaise)) / 100;
    }

    const client = getRazorpay();
    if (!client) {
      return res.status(500).json({ message: "Razorpay is not configured on server" });
    }

    const order = await client.orders.create({
      amount: Math.round(finalAmount * 100),
      currency: "INR",
      receipt: "rcpt_" + Date.now() + "_" + plan,
      notes: { phone, plan, couponCode: couponCode || "" },
    });

    res.json({
      orderId: order.id,
      key: process.env.RAZORPAY_KEY_ID,
      amount: order.amount,
      currency: order.currency,
      plan,
      originalAmount,
      cashback,
      finalAmount,
      couponCode: couponCode || "",
    });
  } catch (err) {
    console.error("createOrder error:", err);
    res.status(500).json({ message: err.message || "Could not create order" });
  }
};

// ===========================================================
// POST /api/plans/verify
// ===========================================================
exports.verifyPayment = async (req, res) => {
  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      plan,
      couponCode = "",
    } = req.body;
    const phone = normPhone(req.body.phone);

    const catalog = await loadCatalog();
    if (!phone || !catalog[plan]) {
      return res.status(400).json({ message: "Phone and valid plan are required" });
    }
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ message: "Missing Razorpay fields" });
    }

    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(razorpay_order_id + "|" + razorpay_payment_id)
      .digest("hex");

    if (expectedSignature !== razorpay_signature) {
      return res.status(401).json({ message: "Invalid Razorpay signature" });
    }

    const originalAmount = catalog[plan].price;
    let cashback = 0;
    let coupon = null;
    if (couponCode) {
      coupon = await Coupon.findOne({ code: String(couponCode).toUpperCase().trim() });
      if (coupon) {
        const valid = coupon.isValidNow(plan);
        if (valid.ok) cashback = coupon.computeCashback(originalAmount);
      }
    }

    // Actual charged amount from Razorpay order (most accurate).
    let amountPaid = Math.max(0, originalAmount - cashback);
    try {
      const client = getRazorpay();
      if (client) {
        const rzpOrder = await client.orders.fetch(razorpay_order_id);
        if (rzpOrder && rzpOrder.amount) {
          amountPaid = rzpOrder.amount / 100;
        }
      }
    } catch (_e) {
      // Non-fatal
    }

    const startDate = new Date();
    const endDate = new Date(startDate.getTime() + catalog[plan].durationDays * 24 * 60 * 60 * 1000);

    await Subscription.updateMany(
      { phone, status: "active" },
      { $set: { status: "expired" } }
    );

    const sub = await Subscription.create({
      phone,
      plan,
      startDate,
      endDate,
      status: "active",
      razorpayOrderId: razorpay_order_id,
      razorpayPaymentId: razorpay_payment_id,
      razorpaySignature: razorpay_signature,
      originalAmount,
      couponCode: coupon ? coupon.code : "",
      cashback,
      amountPaid,
    });

    if (coupon) {
      coupon.usedCount += 1;
      if (!coupon.usedByPhones.includes(phone)) {
        coupon.usedByPhones.push(phone);
      }
      await coupon.save();
    }

    console.log("SUBSCRIPTION saved:", { _id: sub._id, phone, plan, endDate, amountPaid });

    res.json({
      ok: true,
      message: "Payment verified and subscription activated",
      subscription: {
        plan: sub.plan,
        startDate: sub.startDate,
        endDate: sub.endDate,
        amountPaid: sub.amountPaid,
      },
    });
  } catch (err) {
    console.error("verifyPayment error:", err);
    res.status(500).json({ message: err.message || "Verification failed" });
  }
};

// ===========================================================
// GET /api/plans/can-post?phone=+91...
// ===========================================================
exports.canPostRide = async (req, res) => {
  try {
    const phone = normPhone(req.query.phone);
    if (!phone) return res.status(400).json({ message: "Valid phone is required" });

    const now = new Date();
    const sub = await Subscription.findOne({
      phone, status: "active", endDate: { $gt: now },
    }).sort({ endDate: -1 });

    if (!sub) return res.json({ canPostRide: false, reason: "No active subscription" });

    const daysLeft = Math.ceil((sub.endDate - now) / (1000 * 60 * 60 * 24));
    res.json({ canPostRide: true, plan: sub.plan, daysLeft, endDate: sub.endDate });
  } catch (err) {
    console.error("canPostRide error:", err);
    res.status(500).json({ message: err.message });
  }
};

// ===========================================================
// GET /api/plans/coupon/list?plan=daily
// ===========================================================
exports.listCoupons = async (req, res) => {
  try {
    const plan = req.query.plan || "";
    const now = new Date();
    const all = await Coupon.find({ isActive: true, expiresAt: { $gt: now } })
      .sort({ createdAt: 1 })
      .lean();

    const visible = all.filter((c) => {
      if (c.usageLimit > 0 && c.usedCount >= c.usageLimit) return false;
      if (plan && c.appliesTo && c.appliesTo.length > 0 && !c.appliesTo.includes(plan)) return false;
      return true;
    });

    res.json({
      coupons: visible.map((c) => ({
        code: c.code,
        type: c.type,
        value: c.value,
        maxCashback: c.maxCashback,
        appliesTo: c.appliesTo,
        expiresAt: c.expiresAt,
        description: c.description,
      })),
    });
  } catch (err) {
    console.error("listCoupons error:", err);
    res.status(500).json({ message: err.message });
  }
};

// Auto-seed default coupons on first server boot when collection is empty.
exports.ensureCouponsSeeded = async () => {
  try {
    const count = await Coupon.estimatedDocumentCount();
    if (count > 0) return { seeded: false, count };

    const DEFAULT_COUPONS = [
      ["WELCOME10",  "percent",  10, 100, 60, []],
      ["TRAVEL50",   "flat",     50,   0, 45, []],
      ["NEWUSER100", "flat",    100,   0, 30, []],
      ["DAILY15",    "percent",  15,  30, 30, ["daily"]],
      ["MONTHLY200", "flat",    200,   0, 60, ["monthly"]],
      ["YEARLY500",  "flat",    500,   0, 90, ["yearly"]],
    ];
    let inserted = 0;
    for (const [code, type, value, maxCashback, days, appliesTo] of DEFAULT_COUPONS) {
      const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
      const desc = type === "percent"
        ? value + "% off" + (maxCashback ? " up to Rs." + maxCashback : "")
        : "Rs." + value + " cashback";
      await Coupon.create({
        code, type, value, maxCashback, expiresAt, appliesTo,
        description: desc, isActive: true, usageLimit: 0, usedCount: 0,
      });
      inserted++;
    }
    console.log("Auto-seeded " + inserted + " coupons into Atlas");
    return { seeded: true, count: inserted };
  } catch (err) {
    console.warn("ensureCouponsSeeded skipped:", err.message);
    return { seeded: false, error: err.message };
  }
};

// Compatibility export (defaults only; live values come from the DB).
exports.PLAN_META = PLAN_META;
exports.DEFAULT_PRICING = DEFAULTS;
