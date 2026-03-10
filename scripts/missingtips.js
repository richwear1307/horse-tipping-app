const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();

async function listMissingTipsPerRace(competitionId, raceDate = null) {
  if (!competitionId) {
    throw new Error("competitionId is required");
  }

  // 1) Load registered users for this competition
  const usersSnap = await db.collection("users").get();

  const registeredUsers = usersSnap.docs
    .map((doc) => ({ id: doc.id, ...doc.data() }))
    .filter((u) => {
      const ids = Array.isArray(u.registeredCompetitionIds)
        ? u.registeredCompetitionIds
        : [];
      return ids.includes(competitionId);
    });

  const registeredUserIds = new Set(registeredUsers.map((u) => u.id));

  // 2) Load races for this competition
  let racesQuery = db.collection("races").where("competitionId", "==", competitionId);

  const racesSnap = await racesQuery.get();

  let races = racesSnap.docs
    .map((doc) => ({ id: doc.id, ...doc.data() }))
    .sort((a, b) => {
      const ad = String(a.date || "");
      const bd = String(b.date || "");
      if (ad !== bd) return ad.localeCompare(bd);
      return Number(a.order || 0) - Number(b.order || 0);
    });

function dayFromRaceId(raceId) {
  const id = String(raceId || "").trim();
  const m = id.match(/^(\d{4}-\d{2}-\d{2})_/);
  return m ? m[1] : null;
}

if (raceDate) {
  races = races.filter((r) => dayFromRaceId(r.id) === raceDate);
}

  if (!races.length) {
    console.log("No races found.");
    return;
  }

  const raceIds = races.map((r) => r.id);

  // 3) Load all tips for these races
  // Firestore "in" supports max 10 values, so chunk
  const chunkSize = 10;
  const tipsByRaceId = new Map();

  for (let i = 0; i < raceIds.length; i += chunkSize) {
    const chunk = raceIds.slice(i, i + chunkSize);

    const tipsSnap = await db
      .collection("tips")
      .where("raceId", "in", chunk)
      .get();

    tipsSnap.forEach((doc) => {
      const tip = doc.data() || {};
      const raceId = String(tip.raceId || "").trim();
      const userId = String(tip.userId || "").trim();

      if (!raceId || !userId) return;

      if (!tipsByRaceId.has(raceId)) {
        tipsByRaceId.set(raceId, new Set());
      }

      tipsByRaceId.get(raceId).add(userId);
    });
  }

  // 4) Report missing users per race
  const output = races.map((race) => {
    const tippedUsers = tipsByRaceId.get(race.id) || new Set();

    const missingUsers = registeredUsers.filter((u) => !tippedUsers.has(u.id));

    return {
      raceId: race.id,
      raceName: String(race.name || ""),
      date: String(race.date || ""),
      registeredCount: registeredUsers.length,
      tippedCount: tippedUsers.size,
      missingCount: missingUsers.length,
      missingUsers: missingUsers.map((u) => ({
        userId: u.id,
        displayName: String(u.displayName || u.username || u.email || "(unknown)"),
        email: String(u.email || ""),
      })),
    };
  });

  // 5) Print nicely
  for (const row of output) {
    console.log("");
    console.log(`Race: ${row.raceName} (${row.raceId})`);
    console.log(`Date: ${row.date}`);
    console.log(
      `Registered: ${row.registeredCount} | Tipped: ${row.tippedCount} | Missing: ${row.missingCount}`
    );

    if (!row.missingUsers.length) {
      console.log("  Everyone has submitted a tip.");
      continue;
    }

    for (const user of row.missingUsers) {
      console.log(`  - ${user.displayName} [${user.userId}] ${user.email}`);
    }
  }

  return output;
}

// Example usage:
// node scripts/missingTips.js cheltenham_2026
// node scripts/missingTips.js cheltenham_2026 2026-03-10
(async () => {
  try {
    const competitionId = process.argv[2];
    const raceDate = process.argv[3] || null;

    await listMissingTipsPerRace(competitionId, raceDate);
    process.exit(0);
  } catch (err) {
    console.error("Error:", err);
    process.exit(1);
  }
})();