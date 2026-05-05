// routes/rideRoutes.js
// REST endpoints for ride operations (CommonJS)

const express = require("express");
const router = express.Router();

const {
  createRide,
  getAllRides,
  searchRides,
} = require("../controllers/rideController");

// POST /api/rides            → create a new ride (PostRide page)
router.post("/", createRide);

// GET  /api/rides            → list all rides, newest first (FindFriends page)
router.get("/", getAllRides);

// GET  /api/rides/search     → search by from+to (FindRide → FindFriends)
router.get("/search", searchRides);

module.exports = router;
