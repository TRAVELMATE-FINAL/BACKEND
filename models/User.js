const mongoose = require("mongoose");

const userSchema = new mongoose.Schema(
  {
    phone: {
      type: String,
      required: true,
      unique: true,
    },

    isVerified: {
      type: Boolean,
      default: false,
    },

    // Profile fields
    fullName: {
      type: String,
      trim: true,
    },

    email: {
      type: String,
      trim: true,
      lowercase: true,
    },

    dob: {
      type: Date,
    },

    city: {
      type: String,
      trim: true,
    },

    about: {
      type: String,
      maxlength: 300,
    },

    gender: {
      type: String,
      enum: ["Male", "Female", ""],
      default: "",
    },

    photo: {
      type: String, // base64 or URL
    },

    // Moderation fields (shared with the admin panel).
    // Written by the admin backend when a user is blocked; the
    // customer app reads these to enforce the block at login.
    isBlocked: {
      type: Boolean,
      default: false,
    },
    blockReason: {
      type: String,
      default: "",
    },
    blockedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("User", userSchema);
