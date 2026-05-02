require("dotenv").config();
const express = require("express");
const cors = require("cors");
const connectDB = require("./config/db");

const app = express();

// ======================
// CONNECT DATABASE
// ======================
connectDB();

// ======================
// MIDDLEWARE
// ======================
app.use(cors());
app.use(express.json()); // ✅ simplified (no base64 needed anymore)

// ======================
// ROUTES
// ======================
const authRoutes = require("./routes/registerRoutes");

app.use("/api/auth", authRoutes);

// ======================
// HEALTH CHECK
// ======================
app.get("/", (req, res) => {
  res.send("API Running...");
});

// ======================
// GLOBAL ERROR HANDLER
// ======================
app.use((err, req, res, next) => {
  console.error("❌ GLOBAL ERROR:", err);

  if (res.headersSent) {
    return next(err);
  }

  res.status(500).json({
    message: err.message || "Internal Server Error",
  });
});

// ======================
// START SERVER
// ======================
const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});