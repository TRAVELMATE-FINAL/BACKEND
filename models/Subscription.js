const mongoose = require("mongoose");

const subscriptionSchema = new mongoose.Schema(
  {
    phone:    { type: String, required: true, index: true, trim: true },
    plan:     { type: String, enum: ["daily", "monthly", "yearly"], required: true },
    startDate:{ type: Date, default: Date.now, required: true },
    endDate:  { type: Date, required: true, index: true },
    status:   { type: String, enum: ["active", "expired", "cancelled"], default: "active" },

    // Payment info from Razorpay
    razorpayOrderId:   { type: String },
    razorpayPaymentId: { type: String },
    razorpaySignature: { type: String },

    // Pricing breakdown
    originalAmount: { type: Number, required: true },   // ₹ before coupon
    couponCode:     { type: String, default: "" },
    cashback:       { type: Number, default: 0 },        // amount knocked off in ₹
    amountPaid:     { type: Number, required: true },   // ₹ actually paid
  },
  { timestamps: true }
);

// Helper — returns true if this sub is still active right now
subscriptionSchema.virtual("isCurrentlyActive").get(function () {
  return this.status === "active" && this.endDate > new Date();
});

module.exports = mongoose.model("Subscription", subscriptionSchema);
