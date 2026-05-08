// routes/planRoutes.js
const express = require("express");
const router = express.Router();
const ctrl = require("../controllers/planController");

router.get("/",            ctrl.getPlans);          // catalogue
router.get("/me",          ctrl.getMySubscription); // active sub for a phone
router.get("/can-post",    ctrl.canPostRide);       // post-ride gate

router.get("/coupon/list",   ctrl.listCoupons);     // list active coupons (chips on SecurePayment)
router.post("/coupon/apply", ctrl.applyCoupon);     // validate + compute cashback
router.post("/order",        ctrl.createOrder);     // create Razorpay order
router.post("/verify",       ctrl.verifyPayment);   // verify signature + save sub

module.exports = router;
