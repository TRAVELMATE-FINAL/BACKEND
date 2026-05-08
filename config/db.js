// config/db.js
// MongoDB connection helper using Mongoose (CommonJS)

const mongoose = require("mongoose");

// Drop stale unique indexes left behind by older schema versions.
// In particular: email used to be unique; the schema no longer declares
// that, but MongoDB still carries the old `email_1` unique index, causing
// E11000 duplicate-key errors when two users share an email.
async function cleanupStaleIndexes() {
  try {
    const coll = mongoose.connection.db.collection("users");
    const indexes = await coll.indexes();
    const emailIdx = indexes.find((i) => i.name === "email_1" && i.unique);
    if (emailIdx) {
      await coll.dropIndex("email_1");
      console.log("🧹 Dropped stale unique index: users.email_1");
    }
  } catch (err) {
    // Non-fatal — log and continue
    console.warn("⚠️  Index cleanup skipped:", err.message);
  }
}

const connectDB = async () => {
  try {
    const conn = await mongoose.connect(process.env.MONGO_URI);
    console.log(`✅ MongoDB Connected: ${conn.connection.host}`);

    // Run once after the connection is open
    await cleanupStaleIndexes();
  } catch (err) {
    console.error(`❌ MongoDB Error: ${err.message}`);
    process.exit(1);
  }
};

module.exports = connectDB;
