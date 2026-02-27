import fs from "fs";
import { parse } from "csv-parse/sync";
import admin from "firebase-admin";

// 1) Auth: point this at your service account JSON
// export GOOGLE_APPLICATION_CREDENTIALS="/path/serviceAccount.json"
admin.initializeApp({
  credential: admin.credential.applicationDefault(),
});

const db = admin.firestore();

function toTimestamp(value) {
  // Your sheet shows strings like: "18th February 2026 at 14:00:00 UTC"
  // Node Date can usually parse these. If it ever fails, see note below.
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return admin.firestore.Timestamp.fromDate(d);
}

function toInt(value) {
  if (value === "" || value == null) return null;
  const n = parseInt(value, 10);
  return Number.isNaN(n) ? null : n;
}

function toFloat(value) {
  if (value === "" || value == null) return null;
  const n = parseFloat(value);
  return Number.isNaN(n) ? null : n;
}

const csvPath = process.argv[2] || "races.csv";
const input = fs.readFileSync(csvPath, "utf8");

// If your CSV has headers exactly like the sheet columns, this works:
const records = parse(input, {
  columns: true,
  skip_empty_lines: true,
  trim: true,
});

const bulkWriter = db.bulkWriter();
bulkWriter.onWriteError((err) => {
  // Retry transient errors automatically
  if (err.failedAttempts < 5) return true;
  console.error("Write failed permanently:", err);
  return false;
});

let count = 0;

for (const row of records) {
  const raceId = row.raceId?.trim();
  if (!raceId) {
    console.warn("Skipping row with no raceId:", row);
    continue;
  }

  const docRef = db.collection("races").doc(raceId);

  const data = {
    competitionId: row.competitionId?.trim() || null,
    meeting: row.meeting?.trim() || null,
    name: row.name?.trim() || null,

    // keep your existing date string if you want it
    date: row.date?.trim() || null,

    // strongly recommended query fields
    startAt: toTimestamp(row.offTime),
    lockAt: toTimestamp(row.lockAt),

    order: toInt(row.order),
    placesPaid: toInt(row.placesPaid),
    eachWayFraction: toFloat(row.eachWayFraction) ?? 0.2,

    // you can fill this later; importer keeps it stable
    horseIds: Array.isArray(row.horseIds)
      ? row.horseIds
      : (row.horseIds ? String(row.horseIds).split("|").map(s => s.trim()).filter(Boolean) : []),

    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  // Upsert (safe to re-run)
  bulkWriter.set(docRef, data, { merge: true });
  count++;
}

await bulkWriter.close();
console.log(`Imported/updated ${count} races from ${csvPath}`);
