// server.js
// TravelMate backend entry point (CommonJS)

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const connectDB = require("./config/db");

// Routes
const authRoutes = require("./routes/registerRoutes");   // OTP / profile (existing)
const rideRoutes = require("./routes/rideRoutes");       // PostRide / FindRide
const mapRoutes  = require("./routes/mapRoutes");        // /api/geocode + /api/route

const app = express();

// ----- DB -----
connectDB();

// ----- Middleware -----
app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// ----- Mount routes -----
app.use("/api/auth",  authRoutes);   // /api/auth/send-otp, /verify-otp, /profile
app.use("/api/rides", rideRoutes);   // /api/rides, /api/rides/search
app.use("/api",       mapRoutes);    // /api/geocode, /api/route

// ----- Health check -----
app.get("/", (req, res) => {
  res.json({ message: "TravelMate API Running" });
});

// ----- 404 -----
app.use((req, res) => {
  res.status(404).json({ success: false, message: "Route not found" });
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
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
