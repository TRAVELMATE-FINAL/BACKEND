// scripts/seed-coupons.js
// Seed a starter set of coupon codes into MongoDB Atlas.
// Usage:  node scripts/seed-coupons.js
require("dotenv").config({ path: require("path").resolve(__dirname, "..", ".env") });
const mongoose = require("mongoose");
const Coupon = require("../models/Coupon");

const COUPONS = [
  // Code,        type,      value, maxCashback, days valid, plans (empty = all)
  ["WELCOME10",  "percent",  10,  100,   60,  []],
  ["TRAVEL50",   "flat",     50,    0,   45,  []],
  ["NEWUSER100", "flat",    100,    0,   30,  []],
  ["DAILY15",    "percent",  15,   30,   30,  ["daily"]],
  ["MONTHLY200", "flat",    200,    0,   60,  ["monthly"]],
  ["YEARLY500",  "flat",    500,    0,   90,  ["yearly"]],
];

(async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log("✅ Connected to Atlas:", mongoose.connection.host);

    let created = 0, updated = 0;
    for (const [code, type, value, maxCashback, days, appliesTo] of COUPONS) {
      const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
      const desc =
        type === "percent"
          ? value + "% off" + (maxCashback ? " up to ₹" + maxCashback : "")
          : "₹" + value + " cashback";

      const existing = await Coupon.findOne({ code });
      if (existing) {
        existing.type = type;
        existing.value = value;
        existing.maxCashback = maxCashback;
        existing.expiresAt = expiresAt;
        existing.appliesTo = appliesTo;
        existing.description = desc;
        existing.isActive = true;
        await existing.save();
        updated++;
      } else {
        await Coupon.create({
          code, type, value, maxCashback, expiresAt, appliesTo,
          description: desc, isActive: true, usageLimit: 0, usedCount: 0,
        });
        created++;
      }
    }

    console.log("📝 Coupons seeded —", { created, updated });
    const all = await Coupon.find().lean();
    console.log("\n┌── Coupons currently in DB ──");
    for (const c of all) {
      const cb = c.type === "percent"
        ? c.value + "%" + (c.maxCashback ? " (max ₹" + c.maxCashback + ")" : "")
        : "₹" + c.value;
      const plans = c.appliesTo.length ? c.appliesTo.join(",") : "all";
      console.log("│ " + c.code.padEnd(12) + " " + cb.padEnd(20) + "  plans: " + plans + "  expires: " + c.expiresAt.toISOString().slice(0,10));
    }
    console.log("└─");

    await mongoose.disconnect();
    process.exit(0);
  } catch (err) {
    console.error("❌ Seed failed:", err.message);
    process.exit(1);
  }
})();
