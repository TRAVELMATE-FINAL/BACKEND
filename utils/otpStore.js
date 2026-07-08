// OTP store backed by MongoDB.
//
// Previously this used an in-memory Map, which lost the OTP whenever the
// server restarted or when a second app instance/worker handled the
// verify request (send hit one process, verify hit another). That caused
// "Invalid or expired OTP" even when the user typed the correct code.
//
// Storing OTPs in MongoDB fixes that: every process reads the same store.
const Otp = require("../models/Otp");

const OTP_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Save (or overwrite) the OTP for a phone number.
const setOtp = async (phone, otp) => {
  const expiresAt = new Date(Date.now() + OTP_TTL_MS);
  await Otp.findOneAndUpdate(
    { phone },
    { phone, otp: String(otp), expiresAt },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
};

// Verify the OTP. Returns true only if it matches and hasn't expired.
// A used or wrong OTP is not consumed unless it matched.
const verifyOtp = async (phone, otp) => {
  const record = await Otp.findOne({ phone });
  if (!record) return false;

  if (Date.now() > record.expiresAt.getTime()) {
    await Otp.deleteOne({ _id: record._id });
    return false;
  }

  if (record.otp === String(otp)) {
    await Otp.deleteOne({ _id: record._id }); // one-time use
    return true;
  }

  return false;
};

module.exports = { setOtp, verifyOtp };
