// migrate-to-new-atlas.js
// --------------------------------------------------------------------------
// One-time migration: copy ALL data from the OLD Atlas cluster (Tesco DB)
// into the NEW Atlas cluster (Travelmate DB).
//
// What it does:
//   1. Connects to the OLD cluster (read-only — it NEVER deletes old data).
//   2. Connects to the NEW cluster.
//   3. Copies every collection faithfully (same names) so the apps keep
//      working — users, rides, coupons, subscriptions, etc.
//   4. ALSO builds a single merged collection called "all_data" that holds
//      every document from every collection (each tagged with the
//      collection it came from), to satisfy the "single collection" request.
//   5. Verifies document counts at the end.
//
// It is SAFE to run more than once (idempotent): per-collection copies
// upsert by _id, and "all_data" is rebuilt from scratch each run.
//
// HOW TO RUN (from the server folder so the mongodb driver resolves):
//   cd travelmatefinal/server
//   node scripts/migrate-to-new-atlas.js
//
// You can override the connection strings with env vars OLD_URI / NEW_URI
// if needed; otherwise the defaults below are used.
// --------------------------------------------------------------------------

const { MongoClient } = require("mongodb");

// ---- OLD cluster (source) -------------------------------------------------
const OLD_URI =
  process.env.OLD_URI ||
  "mongodb://monicaramaraj_db_user:moni1701@ac-6nsiohn-shard-00-00.kt10iua.mongodb.net:27017,ac-6nsiohn-shard-00-01.kt10iua.mongodb.net:27017,ac-6nsiohn-shard-00-02.kt10iua.mongodb.net:27017/Tesco?ssl=true&replicaSet=atlas-eaw0uc-shard-0&authSource=admin&retryWrites=true&w=majority";
const OLD_DB = process.env.OLD_DB || "Tesco";

// ---- NEW cluster (destination) -------------------------------------------
const NEW_URI =
  process.env.NEW_URI ||
  "mongodb+srv://travelmateproject2026_db_user:Tesco123@ac-bztwcm6.nz6yhyw.mongodb.net/Travelmate?retryWrites=true&w=majority&appName=TravelMate";
const NEW_DB = process.env.NEW_DB || "Travelmate";

// Name of the merged single collection.
const MERGED_COLLECTION = process.env.MERGED_COLLECTION || "all_data";

async function main() {
  console.log("──────────────────────────────────────────────");
  console.log("TravelMate data migration → new Atlas cluster");
  console.log("  Source: %s  (db: %s)", maskUri(OLD_URI), OLD_DB);
  console.log("  Target: %s  (db: %s)", maskUri(NEW_URI), NEW_DB);
  console.log("──────────────────────────────────────────────");

  const oldClient = new MongoClient(OLD_URI);
  const newClient = new MongoClient(NEW_URI);

  try {
    await oldClient.connect();
    console.log("✅ Connected to OLD cluster");
    await newClient.connect();
    console.log("✅ Connected to NEW cluster");

    const oldDb = oldClient.db(OLD_DB);
    const newDb = newClient.db(NEW_DB);

    // List real collections (skip system.* and any prior merged collection).
    const collections = (await oldDb.listCollections().toArray())
      .map((c) => c.name)
      .filter((n) => !n.startsWith("system.") && n !== MERGED_COLLECTION);

    if (collections.length === 0) {
      console.log("⚠️  No collections found in the old database. Nothing to migrate.");
      return;
    }

    console.log("\nCollections to migrate: %s\n", collections.join(", "));

    // Rebuild the merged collection from scratch so re-runs stay clean.
    await newDb.collection(MERGED_COLLECTION).deleteMany({});

    const report = [];

    for (const name of collections) {
      const srcDocs = await oldDb.collection(name).find({}).toArray();

      // 1) Faithful per-collection copy (upsert by _id → idempotent).
      if (srcDocs.length > 0) {
        const ops = srcDocs.map((doc) => ({
          replaceOne: { filter: { _id: doc._id }, replacement: doc, upsert: true },
        }));
        await newDb.collection(name).bulkWrite(ops, { ordered: false });
      }

      // 2) Add to the merged single collection, tagged with its source.
      if (srcDocs.length > 0) {
        const merged = srcDocs.map((doc) => {
          const { _id, ...rest } = doc;
          return { _sourceCollection: name, _originalId: _id, ...rest };
        });
        await newDb.collection(MERGED_COLLECTION).insertMany(merged, { ordered: false });
      }

      const newCount = await newDb.collection(name).countDocuments();
      report.push({ collection: name, source: srcDocs.length, target: newCount });
      console.log(
        "  • %s: copied %d doc(s)  →  target now has %d",
        name,
        srcDocs.length,
        newCount
      );
    }

    const mergedCount = await newDb.collection(MERGED_COLLECTION).countDocuments();

    console.log("\n──────────────── SUMMARY ────────────────");
    let totalSrc = 0;
    for (const r of report) {
      totalSrc += r.source;
      const ok = r.source === r.target ? "OK " : "CHK";
      console.log("  [%s] %-20s source=%d  target=%d", ok, r.collection, r.source, r.target);
    }
    console.log("  ----------------------------------------");
    console.log("  Total source documents:      %d", totalSrc);
    console.log('  Merged "%s" documents: %d', MERGED_COLLECTION, mergedCount);
    console.log("─────────────────────────────────────────");
    console.log("\n✅ Migration complete. All data is now in the '%s' database on the new Atlas cluster.", NEW_DB);
    console.log("   (The old cluster was NOT modified.)");
  } catch (err) {
    console.error("\n❌ Migration failed:", err.message);
    if (/querySrv|ENOTFOUND|getaddrinfo/i.test(err.message)) {
      console.error(
        "\n   This looks like a DNS/connection-string problem on the NEW cluster.\n" +
          "   A mongodb+srv:// URI must use the cluster host (e.g. cluster0.xxxxx.mongodb.net),\n" +
          "   not a shard host (ac-xxxx...). Open Atlas → Connect → Drivers and copy the exact string,\n" +
          "   then re-run with:  NEW_URI=\"<exact string>\" node scripts/migrate-to-new-atlas.js"
      );
    }
    process.exitCode = 1;
  } finally {
    await oldClient.close().catch(() => {});
    await newClient.close().catch(() => {});
  }
}

// Hide the password when printing the URI to the console.
function maskUri(uri) {
  return uri.replace(/\/\/([^:]+):([^@]+)@/, "//$1:****@");
}

main();
