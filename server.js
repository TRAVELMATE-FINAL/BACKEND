// server.js
// TravelMate backend entry point (CommonJS)

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const connectDB = require("./config/db");

// Routes
const authRoutes         = require("./routes/registerRoutes");
const rideRoutes         = require("./routes/rideRoutes");
const mapRoutes          = require("./routes/mapRoutes");
const planRoutes         = require("./routes/planRoutes");
const notificationRoutes = require("./routes/notificationRoutes");
const userActionsRoutes  = require("./routes/userActionsRoutes");

const app = express();

// ----- DB -----
const { ensureCouponsSeeded } = require("./controllers/planController");
connectDB().then(() => {
  setTimeout(function () { ensureCouponsSeeded().catch(function () {}); }, 1500);
});

// ----- Middleware -----
const corsOrigins = (process.env.CORS_ORIGINS || "")
  .split(",").map(function (s) { return s.trim(); }).filter(Boolean);
app.use(cors({
  origin: function (origin, cb) {
    if (!origin) return cb(null, true);
    if (origin.indexOf("localhost") !== -1) return cb(null, true);
    if (corsOrigins.length === 0) return cb(null, true);
    if (corsOrigins.indexOf(origin) !== -1) return cb(null, true);
    return cb(new Error("CORS: origin not allowed: " + origin));
  },
  credentials: true,
}));
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// ----- Request log -----
app.use(function (req, _res, next) {
  console.log("==>", req.method, req.originalUrl);
  next();
});

// ----- Mount routes -----
app.use("/api/auth",          authRoutes);
app.use("/api/rides",         rideRoutes);
app.use("/api",               mapRoutes);
app.use("/api/plans",         planRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/users",         userActionsRoutes);

// ----- Root: simple healthcheck + route listing -----
app.get("/", function (_req, res) {
  res.json({
    message: "TravelMate API Running",
    routesMounted: [
      "POST /api/auth/send-otp",
      "POST /api/auth/verify-otp",
      "POST /api/auth/profile",
      "GET  /api/auth/profile",
      "POST /api/rides",
      "GET  /api/rides",
      "GET  /api/notifications",
      "PATCH /api/notifications/:id/read",
      "GET  /api/route",
      "GET  /api/plans",
      "POST /api/plans/order",
      "POST /api/plans/verify",
      "POST /api/users/block",
      "DELETE /api/users/block/:phone",
      "GET  /api/users/blocked",
      "POST /api/users/report",
      "GET  /health"
    ]
  });
});

// ----- /health: ultra-light keep-alive endpoint -----
// External uptime monitors should ping this every 10 minutes to prevent
// Renders free tier from spinning down. Does NOT touch the database.
app.get("/health", function (_req, res) {
  res.json({
    ok: true,
    uptime: Math.round(process.uptime()),
    timestamp: new Date().toISOString()
  });
});

// ----- Verbose 404 -----
app.use(function (req, res) {
  console.warn("404:", req.method, req.originalUrl);
  res.status(404).json({
    success: false,
    message: "Route not found",
    requested: req.method + " " + req.originalUrl,
    hint: "Check that the backend has been redeployed on Render with the latest code."
  });
});

// ----- Global error handler -----
app.use(function (err, _req, res, next) {
  console.error("GLOBAL ERROR:", err);
  if (res.headersSent) return next(err);
  res.status(500).json({
    success: false,
    message: err.message || "Internal Server Error"
  });
});

// ----- Keep-alive self-ping (layer 1) -----
// Render free tier spins the service down after ~15 min of inactivity.
// While the server IS running, this fires GET /health every 10 minutes
// to delay spin-down. Uses Nodes built-in https module - no new
// dependency. Set SELF_URL on Render to enable.
//
// IMPORTANT: this only works while the server is awake. To wake the
// server back up after it has spun down you need an EXTERNAL cron
// service (UptimeRobot, GitHub Actions cron, cron-job.org).
function startSelfPing() {
  var selfUrl = process.env.SELF_URL || "";
  if (!selfUrl) {
    console.log("SELF_URL not set - self-ping disabled.");
    return;
  }
  var targetUrl = selfUrl.replace(/\/+$/, "") + "/health";
  var client = targetUrl.indexOf("https") === 0 ? require("https") : require("http");
  var INTERVAL_MS = 10 * 60 * 1000;

  var ping = function () {
    var req = client.get(targetUrl, function (resp) {
      console.log("self-ping", targetUrl, "->", resp.statusCode);
      resp.resume();
    });
    req.on("error", function (e) { console.warn("self-ping error:", e.message); });
    req.setTimeout(15000, function () { req.destroy(); });
  };

  setTimeout(ping, 30 * 1000);
  setInterval(ping, INTERVAL_MS);
  console.log("Self-ping enabled ->", targetUrl, "(every 10 min)");
}

// ----- Start -----
var PORT = process.env.PORT || 5000;
app.listen(PORT, function () {
  console.log("Server running on http://localhost:" + PORT);
  startSelfPing();
});
