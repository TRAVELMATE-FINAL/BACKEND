const mongoose = require("mongoose");

const couponSchema = new mongoose.Schema(
  {
    code:        { type: String, required: true, unique: true, uppercase: true, trim: true },
    description: { type: String, default: "" },

    // "flat"    → cashback in ₹ (e.g. value=50 → ₹50 off)
    // "percent" → cashback in % of original price (e.g. value=10 → 10% off, capped by maxCashback)
    type:    { type: String, enum: ["flat", "percent"], required: true },
    value:   { type: Number, required: true },             // ₹ amount or % integer

    // Optional cap when percent (e.g. 10% capped at ₹100)
    maxCashback: { type: Number, default: 0 },

    // Plans this coupon applies to. Empty = all plans.
    appliesTo: [{ type: String, enum: ["daily", "monthly", "yearly"] }],

    // Lifecycle
    expiresAt:  { type: Date, required: true, index: true },
    isActive:   { type: Boolean, default: true },

    // Usage limits
    usageLimit: { type: Number, default: 0 },              // 0 = unlimited
    usedCount:  { type: Number, default: 0 },
    usedByPhones: [{ type: String }],                       // tracks redemptions per user
  },
  { timestamps: true }
);

couponSchema.methods.isValidNow = function (plan) {
  if (!this.isActive) return { ok: false, reason: "Coupon is not active" };
  if (new Date() > this.expiresAt) return { ok: false, reason: "Coupon has expired" };
  if (this.usageLimit > 0 && this.usedCount >= this.usageLimit) {
    return { ok: false, reason: "Coupon usage limit reached" };
  }
  if (plan && this.appliesTo && this.appliesTo.length > 0 && !this.appliesTo.includes(plan)) {
    return { ok: false, reason: "Coupon not valid for this plan" };
  }
  return { ok: true };
};

couponSchema.methods.computeCashback = function (originalAmount) {
  if (this.type === "flat") return Math.min(this.value, originalAmount);
  // percent
  const raw = (originalAmount * this.value) / 100;
  if (this.maxCashback > 0) return Math.min(raw, this.maxCashback, originalAmount);
  return Math.min(raw, originalAmount);
};

module.exports = mongoose.model("Coupon", couponSchema);
