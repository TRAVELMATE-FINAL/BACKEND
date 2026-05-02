const otpMap = new Map();

const setOtp = (phone, otp) => {
  otpMap.set(phone, { otp, expires: Date.now() + 5 * 60 * 1000 });
};

const verifyOtp = (phone, otp) => {
  const data = otpMap.get(phone);
  if (!data) return false;

  if (Date.now() > data.expires) {
    otpMap.delete(phone);
    return false;
  }

  if (data.otp === otp) {
    otpMap.delete(phone);
    return true;
  }

  return false;
};

module.exports = { setOtp, verifyOtp };