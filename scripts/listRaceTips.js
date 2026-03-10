const admin = require("firebase-admin");

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
});

const db = admin.firestore();

async function listRaceTips(competitionId, raceId) {
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

  const registeredById = new Map(
    registeredUsers.map((u) => [
      u.id,
      {
        userId: u.id,
        displayName: String(u.displayName || u.username || "").trim(),
        email: String(u.email || "").trim(),
      },
    ])
  );

  // Load tips for this race
  const tipsSnap = await db
    .collection("tips")
    .where("raceId", "==", raceId)
    .get();

  const tipsByUserId = new Map();
  tipsSnap.forEach((doc) => {
    const t = doc.data() || {};
    const userId = String(t.userId || "").trim();
    if (!userId) return;
    tipsByUserId.set(userId, {
      horseName: String(t.horseName || "").trim(),
      horseId: String(t.horseId || "").trim(),
      odds: String(t.odds || "").trim(),
      autoAssigned: !!t.autoAssigned,
      autoAssignedReason: String(t.autoAssignedReason || "").trim(),
      date: String(t.date || "").trim(),
      raceName: String(t.raceName || "").trim(),
    });
  });

  // Optional: race info
  const raceSnap = await db.collection("races").doc(raceId).get();
  const race = raceSnap.exists ? raceSnap.data() || {} : {};

  console.log("");
  console.log("=".repeat(80));
  console.log(`Race: ${String(race.name || "")}`);
  console.log(`Race ID: ${raceId}`);
  console.log(`Competition ID: ${competitionId}`);
  console.log(`Date: ${String(race.date || "")}`);
  console.log("=".repeat(80));
  console.log("");

  const rows = registeredUsers
    .map((u) => {
      const base = registeredById.get(u.id);
      const tip = tipsByUserId.get(u.id);

      return {
        userId: base.userId,
        displayName: base.displayName || "(No display name)",
        email: base.email || "",
        hasTip: !!tip,
        horseName: tip?.horseName || "",
        odds: tip?.odds || "",
        autoAssigned: tip?.autoAssigned ? "YES" : "",
      };
    })
    .sort((a, b) => a.displayName.localeCompare(b.displayName));

  for (const row of rows) {
    if (row.hasTip) {
      console.log(
        `${row.displayName} | ${row.email} | TIP: ${row.horseName} ${row.odds ? `(${row.odds})` : ""}${row.autoAssigned ? " | AUTO-ASSIGNED" : ""}`
      );
    } else {
      console.log(`${row.displayName} | ${row.email} | NO TIP`);
    }
  }

  console.log("");
  console.log(`Registered users: ${registeredUsers.length}`);
  console.log(`Tips submitted: ${rows.filter((r) => r.hasTip).length}`);
  console.log(`Missing tips: ${rows.filter((r) => !r.hasTip).length}`);
  console.log("");

  return rows;
}

(async () => {
  try {
    const competitionId = process.argv[2];
    const raceId = process.argv[3];

    await listRaceTips(competitionId, raceId);
    process.exit(0);
  } catch (err) {
    console.error("Error:", err.message || err);
    process.exit(1);
  }
})();