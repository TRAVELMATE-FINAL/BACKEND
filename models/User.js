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

    // 🔥 Profile fields
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
  },
  { timestamps: true }
);

module.exports = mongoose.model("User", userSchema);