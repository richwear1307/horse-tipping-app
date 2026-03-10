const admin = require("firebase-admin");

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
});

const db = admin.firestore();

async function listRaceTipsByHorse(competitionId, raceId) {
  if (!competitionId) throw new Error("competitionId is required");
  if (!raceId) throw new Error("raceId is required");

  // Load registered users for this competition
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

  const userDisplayNameById = new Map(
    registeredUsers.map((u) => [
      u.id,
      String(u.displayName || u.username || u.email || u.id).trim(),
    ])
  );

  // Load all tips for the race
  const tipsSnap = await db
    .collection("tips")
    .where("raceId", "==", raceId)
    .get();

  // Group by horse
  const horseMap = new Map();

  tipsSnap.forEach((doc) => {
    const t = doc.data() || {};
    const userId = String(t.userId || "").trim();

    // only include registered users
    if (!registeredUserIds.has(userId)) return;

    const horseName = String(t.horseName || "").trim() || "(Unknown horse)";
    const odds = String(t.odds || "").trim();
    const key = `${horseName}|||${odds}`;

    if (!horseMap.has(key)) {
      horseMap.set(key, {
        horseName,
        odds,
        usernames: [],
      });
    }

    horseMap.get(key).usernames.push(
      userDisplayNameById.get(userId) || userId
    );
  });

  // Sort users within each horse group
  const rows = Array.from(horseMap.values())
    .map((row) => ({
      ...row,
      usernames: row.usernames.sort((a, b) => a.localeCompare(b)),
    }))
    .sort((a, b) => {
      if (a.horseName !== b.horseName) {
        return a.horseName.localeCompare(b.horseName);
      }
      return a.odds.localeCompare(b.odds);
    });

  // Optional race info
  const raceSnap = await db.collection("races").doc(raceId).get();
  const race = raceSnap.exists ? raceSnap.data() || {} : {};

  console.log("");
  console.log("=".repeat(80));
  console.log(`Race: ${String(race.name || "")}`);
  console.log(`Race ID: ${raceId}`);
  console.log(`Competition ID: ${competitionId}`);
  console.log("=".repeat(80));
  console.log("");

  if (!rows.length) {
    console.log("No tips found for registered users.");
    return rows;
  }

  for (const row of rows) {
    const oddsLabel = row.odds ? ` (${row.odds})` : "";
    console.log(
      `${row.horseName}${oddsLabel} | ${row.usernames.join(", ")}`
    );
  }

  console.log("");
  console.log(`Distinct horses tipped: ${rows.length}`);
  console.log("");

  return rows;
}

(async () => {
  try {
    const competitionId = process.argv[2];
    const raceId = process.argv[3];

    await listRaceTipsByHorse(competitionId, raceId);
    process.exit(0);
  } catch (err) {
    console.error("Error:", err.message || err);
    process.exit(1);
  }
})();