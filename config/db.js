// config/db.js
// MongoDB connection helper using Mongoose (CommonJS)

const mongoose = require("mongoose");

// Drop stale unique indexes left behind by older schema versions.
// In particular: email used to be unique; the schema no longer declares
// that, but MongoDB still carries the old email_1 unique index, causing
// E11000 duplicate-key errors when two users share an email.
async function cleanupStaleIndexes() {
  try {
    const coll = mongoose.connection.db.collection("users");
    const indexes = await coll.indexes();
    const emailIdx = indexes.find((i) => i.name === "email_1" && i.unique);
    if (emailIdx) {
      await coll.dropIndex("email_1");
      console.log("Dropped stale unique index: users.email_1");
    }
  } catch (err) {
    // Non-fatal - log and continue
    console.warn("Index cleanup skipped:", err.message);
  }
}

// Spot the most common MONGO_URI mistake: a mongodb+srv:// URI pointing at a
// single cluster NODE instead of the cluster SRV host. Node hosts have no DNS
// SRV record, so the driver fails with "querySrv ECONNREFUSED / ENOTFOUND".
function diagnoseUri(uri, err) {
  const msg = err && err.message ? err.message : "";
  const isSrvDnsError = /querySrv|ENOTFOUND|ECONNREFUSED|getaddrinfo/i.test(msg);
  if (!isSrvDnsError) return;

  const m = /mongodb\+srv:\/\/[^@]*@([^/?]+)/i.exec(uri || "");
  const host = m ? m[1] : "";
  const looksLikeNode = /^ac-|-shard-|-00-\d/i.test(host);

  console.error("----------------------------------------------------------");
  console.error("MongoDB SRV lookup failed for host:", host || "(unknown)");
  if (looksLikeNode) {
    console.error("This host is an individual cluster NODE, not the SRV host.");
    console.error("Use the CLUSTER host, e.g. cluster0.xxxxx.mongodb.net");
  } else {
    console.error("Likely a DNS/network issue. Check the Atlas IP Access List.");
  }
  console.error("----------------------------------------------------------");
}

// Remove any database name from the URI path so it can NEVER conflict with the
// pinned dbName below. MongoDB rejects two db names that differ only by case
// (e.g. existing "Travelmate" vs a URI path "/TravelMate"), throwing
// "db already exists with different case". Stripping the path and relying
// solely on dbName: "Travelmate" makes that impossible regardless of casing.
function stripDbNameFromUri(uri) {
  if (!uri) return uri;
  const parts = uri.split("?");
  const beforeQuery = parts[0];
  const query = parts.length > 1 ? parts.slice(1).join("?") : "";

  const schemeSep = "://";
  const schemeIdx = beforeQuery.indexOf(schemeSep);
  if (schemeIdx === -1) return uri;

  const afterScheme = beforeQuery.slice(schemeIdx + schemeSep.length);
  const slashIdx = afterScheme.indexOf("/");
  const hostSection = slashIdx === -1 ? afterScheme : afterScheme.slice(0, slashIdx);

  const rebuilt = beforeQuery.slice(0, schemeIdx + schemeSep.length) + hostSection;
  return rebuilt + "/" + (query ? "?" + query : "");
}

const connectDB = async (retries = 5, delayMs = 4000) => {
  if (!process.env.MONGO_URI) {
    console.error("MongoDB Error: MONGO_URI is not set in the environment.");
    process.exit(1);
  }

  const cleanUri = stripDbNameFromUri(process.env.MONGO_URI);

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      // Pin the database name to "Travelmate" no matter what the URI path says,
      // so the app and admin panel always read/write the SAME database.
      const conn = await mongoose.connect(cleanUri, {
        dbName: "Travelmate",
        serverSelectionTimeoutMS: 10000,
      });
      console.log(
        `MongoDB Connected: host=${conn.connection.host} db=${conn.connection.name}`
      );

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
      console.log(`Retrying in ${Math.round(delayMs / 1000)}s...`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
};

module.exports = connectDB;
