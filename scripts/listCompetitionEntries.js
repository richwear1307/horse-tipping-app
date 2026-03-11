const admin = require("firebase-admin");

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
});

const db = admin.firestore();

async function listCompetitionEntries(competitionId) {
  if (!competitionId) {
    throw new Error("competitionId required");
  }

  const snap = await db
    .collection("competitions")
    .doc(competitionId)
    .collection("leaderboard")
    .orderBy("totalReturnInclStake", "desc")
    .get();

  if (snap.empty) {
    console.log("No entries found.");
    return;
  }

  const rows = snap.docs.map((doc) => ({
    userId: doc.id,
    ...doc.data(),
  }));

  console.log("");
  console.log(`Competition: ${competitionId}`);
  console.log("=".repeat(70));
  console.log("");

  rows.forEach((row, index) => {
    const username =
      row.username ||
      row.displayName ||
      row.userEmail ||
      row.userId;

    const total = Number(row.totalReturnInclStake ?? 0).toFixed(2);

    console.log(
      `${index + 1}. ${username} — £${total}`
    );
  });

  console.log("");
  console.log(`Total entrants: ${rows.length}`);
}

(async () => {
  try {
    const competitionId = process.argv[2];

    await listCompetitionEntries(competitionId);

    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
})();