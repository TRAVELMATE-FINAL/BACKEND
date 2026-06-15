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
    if (!process.env.MONGO_URI) {
      throw new Error("MONGO_URI is not set in the environment.");
    }
    // Pin the database name to "Tesco" no matter what the URI path says.
    // This guarantees the customer app and the admin panel read/write the
    // SAME database, even if a deployment's MONGO_URI omits "/Tesco"
    // (otherwise Mongoose silently falls back to the "test" database and
    // rides/payments/bookings appear to be "missing").
    const conn = await mongoose.connect(process.env.MONGO_URI, { dbName: "Tesco" });
    console.log(`MongoDB Connected: host=${conn.connection.host} db=${conn.connection.name}`);

    // Run once after the connection is open
    await cleanupStaleIndexes();
  } catch (err) {
    console.error(`MongoDB Error: ${err.message}`);
    process.exit(1);
  }
};

module.exports = connectDB;
