import fs from "fs";
import { parse } from "csv-parse/sync";
import admin from "firebase-admin";

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
});

const db = admin.firestore();

function clean(value) {
  if (value == null) return null;
  const s = String(value).trim();
  return s === "" ? null : s;
}

function toInt(value) {
  if (value === "" || value == null) return null;
  const n = parseInt(value, 10);
  return Number.isNaN(n) ? null : n;
}

const csvPath = process.argv[2] || "chelttestrunners.csv";
const input = fs.readFileSync(csvPath, "utf8");

const records = parse(input, {
  columns: true,
  skip_empty_lines: true,
  trim: true,
});

const bulkWriter = db.bulkWriter();
bulkWriter.onWriteError((err) => {
  if (err.failedAttempts < 5) return true;
  console.error("Write failed permanently:", err);
  return false;
});

// Deduplicate: one horse per competition (competitionId + horseId)
const byCompAndHorse = new Map();

for (const row of records) {
  const horseId = clean(row.horseId) || clean(row.docId);
  const competitionId = clean(row.competitionId);
  if (!horseId) continue;

  // If competitionId is missing, still import globally; use a special key
  const key = `${competitionId || "__no_comp__"}::${horseId}`;

  // Last row wins (simple + predictable)
  byCompAndHorse.set(key, row);
}

let count = 0;

for (const row of byCompAndHorse.values()) {
  const horseId = clean(row.horseId) || clean(row.docId);
  const competitionId = clean(row.competitionId);

  if (!horseId) continue;

  const data = {
    horseId,
    name: clean(row.name),
    trainer: clean(row.trainer),
    jockey: clean(row.jockey),

    odds: clean(row.odds),
    number: toInt(row.number),

    competitionId: competitionId || null,
    race: clean(row.race),

    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  // Remove null/empty fields so you don't store blanks
  Object.keys(data).forEach((k) => data[k] == null && delete data[k]);

  // ✅ 1) Global horses collection
  const globalRef = db.collection("horses").doc(horseId);
  bulkWriter.set(globalRef, data, { merge: true });

  // ✅ 2) Competition-scoped horses subcollection (only if competitionId exists)
  if (competitionId) {
    const compRef = db
      .collection("competitions")
      .doc(competitionId)
      .collection("horses")
      .doc(horseId);

    bulkWriter.set(compRef, data, { merge: true });
  }

  count++;
}

await bulkWriter.close();
console.log(`Imported/updated ${count} horse docs from ${csvPath} (global + competitions/{competitionId}/horses)`);