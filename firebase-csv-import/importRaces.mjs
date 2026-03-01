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
  if (!value) return null;

  // Handle formats like: "18th February 2026 at 14:00:00 UTC"
  const cleaned = String(value)
    .trim()
    .replace(/\b(\d{1,2})(st|nd|rd|th)\b/gi, "$1") // 18th -> 18
    .replace(/\sat\s/i, " ") // " at " -> " "
    .replace(/\sUTC$/i, " GMT"); // UTC -> GMT (parsable)

  const d = new Date(cleaned);

  if (Number.isNaN(d.getTime())) {
    console.warn("⚠️ Could not parse date:", value, "->", cleaned);
    return null;
  }

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

/**
 * Accepts:
 * - JSON array strings: ["a","b"]
 * - pipe-separated: a|b|c
 * - actual arrays
 * Returns: string[]
 */
function toStringArray(value) {
  if (value == null || value === "") return [];

  if (Array.isArray(value)) {
    return value.map((v) => String(v).trim()).filter(Boolean);
  }

  const s = String(value).trim();
  if (!s) return [];

  // JSON array string?
  if (s.startsWith("[") && s.endsWith("]")) {
    try {
      const arr = JSON.parse(s);
      if (Array.isArray(arr)) {
        return arr.map((v) => String(v).trim()).filter(Boolean);
      }
      console.warn("⚠️ JSON parsed but was not an array:", s);
      return [];
    } catch (e) {
      console.warn("⚠️ Could not JSON-parse runners/horseIds:", s);
      return [];
    }
  }

  // Pipe-separated fallback
  return s
    .split("|")
    .map((x) => x.trim())
    .filter(Boolean);
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

  // ✅ Read horse IDs from horseIds OR runners
  const horseIds = toStringArray(row.horseIds ?? row.runners);

  const data = {
    competitionId: row.competitionId?.trim() || null,
    meeting: row.meeting?.trim() || null,
    name: row.name?.trim() || null,

    // keep your existing date string if you want it
    date: row.date?.trim() || null,

    // strongly recommended query fields
    offTime: toTimestamp(row.offTime),
    lockAt: toTimestamp(row.lockAt),

    order: toInt(row.order),
    placesPaid: toInt(row.placesPaid),
    eachWayFraction: toFloat(row.eachWayFraction) ?? 0.2,

    horseIds,

    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  // Upsert (safe to re-run)
  bulkWriter.set(docRef, data, { merge: true });
  count++;
}

await bulkWriter.close();
console.log(`Imported/updated ${count} races from ${csvPath}`);