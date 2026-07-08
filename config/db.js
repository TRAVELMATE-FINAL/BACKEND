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

// Spot the most common MONGO_URI mistake: a mongodb+srv:// URI pointing at a
// single cluster NODE (e.g. ac-xxxx... or ...-shard-00-00...) instead of the
// cluster's SRV host (e.g. cluster0.xxxxx.mongodb.net). Node hosts have no DNS
// SRV record, so the driver fails with "querySrv ECONNREFUSED / ENOTFOUND".
function diagnoseUri(uri, err) {
  const isSrvDnsError =
    /querySrv|ENOTFOUND|ECONNREFUSED|getaddrinfo/i.test(err?.message || "");
  if (!isSrvDnsError) return;

  const m = /mongodb\+srv:\/\/[^@]*@([^/?]+)/i.exec(uri || "");
  const host = m ? m[1] : "";
  const looksLikeNode = /^ac-|-shard-|-00-\d/i.test(host);

  console.error("──────────────────────────────────────────────────────────");
  console.error("MongoDB SRV lookup failed for host:", host || "(unknown)");
  if (looksLikeNode) {
    console.error(
      "This host is an individual cluster NODE, not the cluster SRV host."
    );
    console.error(
      "A mongodb+srv:// URI must use the CLUSTER host, e.g. cluster0.xxxxx.mongodb.net"
    );
    console.error(
      "Fix MONGO_URI in your .env: Atlas → Connect → Drivers → copy the Node.js URI."
    );
  } else {
    console.error(
      "Likely a DNS/network issue. Check your internet/VPN, the Atlas IP"
    );
    console.error(
      "Access List (allow your IP or 0.0.0.0/0), and that the cluster isn't paused."
    );
  }
  console.error("──────────────────────────────────────────────────────────");
}

const connectDB = async (retries = 5, delayMs = 4000) => {
  if (!process.env.MONGO_URI) {
    console.error("MongoDB Error: MONGO_URI is not set in the environment.");
    process.exit(1);
  }

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      // Pin the database name to "Travelmate" no matter what the URI path says.
      // This guarantees the customer app and the admin panel read/write the
      // SAME database, even if a deployment's MONGO_URI omits "/Travelmate"
      // (otherwise Mongoose silently falls back to the "test" database and
      // rides/payments/bookings appear to be "missing").
      const conn = await mongoose.connect(process.env.MONGO_URI, {
        dbName: "Travelmate",
        serverSelectionTimeoutMS: 10000,
      });
      console.log(
        `MongoDB Connected: host=${conn.connection.host} db=${conn.connection.name}`
      );

      // Run once after the connection is open
      await cleanupStaleIndexes();
      return;
    } catch (err) {
      console.error(
        `MongoDB Error (attempt ${attempt}/${retries}): ${err.message}`
      );
      diagnoseUri(process.env.MONGO_URI, err);

      if (attempt === retries) {
        console.error("All MongoDB connection attempts failed. Exiting.");
        process.exit(1);
      }
      console.log(`Retrying in ${Math.round(delayMs / 1000)}s…`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
};

module.exports = connectDB;
