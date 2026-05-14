// server.js
// TravelMate backend entry point (CommonJS)

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const connectDB = require("./config/db");

// Routes
const authRoutes = require("./routes/registerRoutes");   // OTP / profile (existing)
const rideRoutes = require("./routes/rideRoutes");       // PostRide / FindRide
const mapRoutes  = require("./routes/mapRoutes");
const planRoutes = require("./routes/planRoutes");        // /api/geocode + /api/route

const app = express();

// ----- DB -----
const { ensureCouponsSeeded } = require("./controllers/planController");
connectDB().then(() => {
  // Auto-seed default coupons (WELCOME10, TRAVEL50, etc.) if Atlas is empty
  setTimeout(() => ensureCouponsSeeded().catch(() => {}), 1500);
});

// ----- Middleware -----
// CORS — allow local dev + production frontends
const corsOrigins = (process.env.CORS_ORIGINS || "")
  .split(",").map((s) => s.trim()).filter(Boolean);
app.use(cors({
  origin: function (origin, cb) {
    if (!origin) return cb(null, true);                 // Postman / curl / mobile native
    if (origin.includes("localhost")) return cb(null, true);
    if (corsOrigins.length === 0) return cb(null, true); // permissive in dev
    if (corsOrigins.includes(origin)) return cb(null, true);
    return cb(new Error("CORS: origin not allowed: " + origin));
  },
  credentials: true,
}));
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// ----- Mount routes -----
app.use("/api/auth",  authRoutes);   // /api/auth/send-otp, /verify-otp, /profile
app.use("/api/rides", rideRoutes);   // /api/rides, /api/rides/search
app.use("/api",       mapRoutes);
app.use("/api/plans", planRoutes);    // /api/geocode, /api/route

// ----- Lightweight request log so Render logs show every URL hit -----
app.use((req, _res, next) => {
  console.log(`➡️  ${req.method} ${req.originalUrl}`);
  next();
});

// ----- Health check -----
app.get("/", (req, res) => {
  res.json({
    message: "TravelMate API Running",
    routesMounted: [
      "POST /api/auth/send-otp",
      "POST /api/auth/verify-otp",
      "POST /api/auth/profile",
      "GET  /api/auth/profile",
      "POST /api/rides",
      "GET  /api/rides",
      "GET  /api/route",
      "GET  /api/plans",
      "POST /api/plans/order",
      "POST /api/plans/verify",
    ],
  });
});

// ----- Verbose 404 (tells you exactly what path was requested) -----
app.use((req, res) => {
  console.warn(`❌ 404: ${req.method} ${req.originalUrl}`);
  res.status(404).json({
    success: false,
    message: "Route not found",
    requested: `${req.method} ${req.originalUrl}`,
    hint:
      "If you expected this route, check that the backend has been " +
      "redeployed on Render with the latest code and that the URL on " +
      "the frontend matches.",
  });
});

// ----- Global error handler -----
app.use((err, req, res, next) => {
  console.error("❌ GLOBAL ERROR:", err);
  if (res.headersSent) return next(err);
  res.status(500).json({
    success: false,
    message: err.message || "Internal Server Error",
  });
});

// ----- Start -----
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log("🚀 Server running on http://localhost:" + PORT);
});
