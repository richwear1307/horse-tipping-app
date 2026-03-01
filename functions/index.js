/**
 * Cloud Function: settles a race when a result document is written.
 *
 * Single source of truth (per user per race):
 *   raceSettlements/{raceId}/users/{userId}.totalReturnInclStake
 *
 * Aggregates:
 *   users/{userId}.totalReturnInclStake                       (delta-based, optional)
 *   competitions/{competitionId}/leaderboard/{userId}         (DETERMINISTIC, no increment drift)
 *   competitions/{competitionId}/leaderboardDays/{YYYY-MM-DD}/users/{userId} (DETERMINISTIC, per day)
 *
 * OPTION A (Gross return incl stake):
 * - NO stake subtraction here
 * - Losers contribute 0
 *
 * IMPORTANT CHANGE:
 * - Competition leaderboard is no longer updated with FieldValue.increment(delta)
 * - Instead, we store per-race contribution on leaderboard doc:
 *     raceReturns.{raceId} = newVal
 *   and recompute totalReturnInclStake = sum(raceReturns)
 *   inside a transaction (so reruns replace, not add).
 *
 * IMPORTANT (FIX):
 * - leaderboardDays doc id MUST be a single safe Firestore doc id (no "/").
 * - We normalize race.date to ISO "YYYY-MM-DD" before using it as a doc id.
 */

"use strict";

// ------------------------------
// Gen2 imports + global options
// ------------------------------
const { setGlobalOptions } = require("firebase-functions/v2");
const logger = require("firebase-functions/logger");
const {
  onDocumentWritten,
  onDocumentUpdated, // ✅ added for seeding on registration
} = require("firebase-functions/v2/firestore");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineJsonSecret } = require("firebase-functions/params");

// ------------------------------
// Admin SDK init (ONCE)
// ------------------------------
const admin = require("firebase-admin");
admin.initializeApp();

// Limit scaling a bit (optional)
setGlobalOptions({ maxInstances: 10 });

// ------------------------------
// Secrets for IONOS SMTP
// ------------------------------
const nodemailer = require("nodemailer");

const SMTP_CONFIG = defineJsonSecret("SMTP_CONFIG");

/**
 * Callable: Send a custom-branded magic sign-in link email via IONOS SMTP.
 *
 * Frontend calls:
 *   httpsCallable(getFunctions(), "sendMagicLink")({ email })
 */
exports.sendMagicLink = onCall(
  {
    region: "europe-west2",
    secrets: [SMTP_CONFIG],
  },
  async (request) => {
    const email = String(request.data?.email || "").trim().toLowerCase();
    logger.info("sendMagicLink invoked", { email });
    if (!email) throw new HttpsError("invalid-argument", "Email required");

    // IMPORTANT: set this to the EXACT origin where your web app runs
    // Must also be present in Firebase Auth -> Authorized domains.
    const actionCodeSettings = {
      url: "https://tcctips.com",
      handleCodeInApp: true,
    };

    // Generate Firebase magic link (Admin SDK)
    const link = await admin
      .auth()
      .generateSignInWithEmailLink(email, actionCodeSettings);

    // Create SMTP transporter INSIDE handler so secrets are available
    const { host, port, user, pass, from } = SMTP_CONFIG.value();

    const transporter = nodemailer.createTransport({
      host,
      port: Number(port || 587),
      secure: Number(port) === 465, // 465 = implicit TLS, 587 = STARTTLS
      auth: { user, pass },
    });

    await transporter.sendMail({
      from: from || `"Thoronton CC Cheltenham Tipping Competition" <${user}>`,
      to: email,
      subject: "Sign in to your account",
      html: `
    <p>Hello,</p>
    <p>Simply click below to sign in to your account without a password.</p>
    <p>
      <a href="${link}" style="display:inline-block;padding:12px 18px;text-decoration:none;border-radius:8px;font-weight:700;">
        Sign in to TCC Tipping Competition
      </a>
    </p>
    <p>If you didn’t request this, you can ignore this email.</p>
    <p>Thanks,<br/>TCC Tipping</p>
  `,
    });

    return { ok: true };
  }
);

// -----------------------------------------------------------------------------
// ✅ NEW: Seed overall leaderboard entry as soon as a user is registered
// -----------------------------------------------------------------------------
// Trigger: users/{userId} updated and registeredCompetitionIds gains a competition id
// Effect: ensures competitions/{competitionId}/leaderboard/{userId} exists immediately at £0
exports.seedLeaderboardOnRegistration = onDocumentUpdated(
  {
    document: "users/{userId}",
    region: "europe-west2",
  },
  async (event) => {
    const before = event.data?.before?.data() || {};
    const after = event.data?.after?.data() || {};
    const userId = event.params.userId;

    const beforeIds = Array.isArray(before.registeredCompetitionIds)
      ? before.registeredCompetitionIds
      : [];
    const afterIds = Array.isArray(after.registeredCompetitionIds)
      ? after.registeredCompetitionIds
      : [];

    // Find newly-added competition IDs
    const beforeSet = new Set(beforeIds.map(String));
    const added = afterIds
      .map(String)
      .filter((id) => id && !beforeSet.has(id));

    if (added.length === 0) return;

    const db = admin.firestore();
    const displayNameLower = String(after.displayName || "")
      .trim()
      .toLowerCase();

    for (const competitionId of added) {
      const ref = db
        .collection("competitions")
        .doc(competitionId)
        .collection("leaderboard")
        .doc(userId);

      await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);

        if (!snap.exists) {
          // Create initial row at £0
          tx.set(
            ref,
            {
              userId,
              competitionId,
              totalReturnInclStake: 0,
              tips: 0,

              // tie-breaker fields for stable ordering
              createdAt: admin.firestore.FieldValue.serverTimestamp(),
              displayNameLower,

              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true }
          );
          return;
        }

        // Ensure tie-break fields exist without overwriting totals
        const d = snap.data() || {};
        const patch = {};
        if (!d.createdAt)
          patch.createdAt = admin.firestore.FieldValue.serverTimestamp();
        if (!d.displayNameLower && displayNameLower)
          patch.displayNameLower = displayNameLower;
        patch.updatedAt = admin.firestore.FieldValue.serverTimestamp();

        if (Object.keys(patch).length > 0) {
          tx.set(ref, patch, { merge: true });
        }
      });

      logger.info("Seeded overall leaderboard on registration", {
        competitionId,
        userId,
      });
    }
  }
);

// -----------------------------------------------------------------------------
// -------------------- EXISTING SETTLEMENT LOGIC (UNCHANGED) -------------------
// -----------------------------------------------------------------------------

function normName(s) {
  return String(s ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

/**
 * Normalize a date value into ISO "YYYY-MM-DD" suitable for a Firestore document id.
 * Accepts:
 *  - "YYYY-MM-DD"
 *  - "DD/MM/YYYY"
 *  - "DD-MM-YYYY"
 * Returns null if it can't be normalized.
 */
function normalizeDayKey(value) {
  const s = String(value ?? "").trim();
  if (!s) return null;

  // Already ISO
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  // DD/MM/YYYY -> YYYY-MM-DD
  let m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;

  // DD-MM-YYYY -> YYYY-MM-DD
  m = s.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;

  // As a final guard: if it contains a slash, do NOT use it as a doc id
  if (s.includes("/")) return null;

  return null;
}

function parseOdds(raw) {
  // Return DECIMAL ODDS (incl stake), e.g. 5/2 => 3.5, 1/1 => 2
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;

  if (typeof raw === "string") {
    const s = raw.trim();

    // decimal input e.g. "3.5"
    const asNum = Number(s);
    if (Number.isFinite(asNum) && asNum > 1) return asNum;

    // fractional input e.g. "5/2", "12/1", "6.5/1"
    const m = s.match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/);
    if (m) {
      const num = Number(m[1]);
      const den = Number(m[2]);
      if (Number.isFinite(num) && Number.isFinite(den) && den !== 0) {
        return 1 + num / den; // decimal odds including stake
      }
    }
  }

  return null;
}

function calcEachWayTotalReturnInclStake({
  odds,
  finishPosition,
  placeFraction = 1 / 5,
  placesPaid = 3,
}) {
  const stakeWin = 5;
  const stakePlace = 5;

  const isWin = finishPosition === 1;
  const isPlaced = finishPosition >= 1 && finishPosition <= placesPaid;

  const winWinnings = isWin ? stakeWin * odds : 0;
  const placeOdds = odds * placeFraction;
  const placeWinnings = isPlaced ? stakePlace * placeOdds : 0;

  const winReturn = isWin ? stakeWin + winWinnings : 0;
  const placeReturn = isPlaced ? stakePlace + placeWinnings : 0;

  const totalReturnInclStake = winReturn + placeReturn;

  return {
    totalReturnInclStake,
    winReturn,
    placeReturn,
    winWinnings,
    placeWinnings,
    placesPaid,
    placeFraction,
  };
}

function calcEachWayProfit({
  odds,
  finishPosition,
  placeFraction = 1 / 5,
  placesPaid = 3,
}) {
  // Profit-only (matches app UI):
  // - stake is NOT included in totals
  // - losers contribute 0
  const stakeWin = 5;
  const stakePlace = 5;

  const isWin = finishPosition === 1;
  const isPlaced = finishPosition >= 1 && finishPosition <= placesPaid;

  const winProfit = isWin ? stakeWin * (odds - 1) : 0;
  const placeProfit = isPlaced ? stakePlace * (odds - 1) * placeFraction : 0;

  const totalProfit = winProfit + placeProfit;

  return { totalProfit, winProfit, placeProfit };
}

async function commitInChunks(writes, chunkSize = 450) {
  for (let i = 0; i < writes.length; i += chunkSize) {
    const batch = admin.firestore().batch();
    const chunk = writes.slice(i, i + chunkSize);
    chunk.forEach((w) => w(batch));
    await batch.commit();
  }
}

/**
 * Deterministically update competition leaderboard for ONE user for ONE race:
 * - sets raceReturns[raceId] = raceReturn
 * - recomputes totalReturnInclStake = sum(raceReturns)
 *
 * This prevents drift/double-applies entirely.
 */
async function upsertCompetitionLeaderboardDeterministic({
  db,
  competitionId,
  userId,
  raceId,
  raceReturn,
  settlementVersion,
}) {
  const ref = db
    .collection("competitions")
    .doc(competitionId)
    .collection("leaderboard")
    .doc(userId);

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const existing = snap.exists ? snap.data() : {};

    const raceProfits = {
      ...(existing.raceProfits || existing.raceReturns || {}),
    };

    // Replace the per-race contribution (do NOT increment)
    raceProfits[raceId] = Number(raceReturn ?? 0);

    // Recompute total deterministically
    let total = 0;
    for (const v of Object.values(raceProfits)) {
      total += Number(v ?? 0);
    }

    tx.set(
      ref,
      {
        userId,
        competitionId,
        totalProfit: total,
        // Backwards compatible field name used by the app UI:
        totalReturnInclStake: total,
        raceProfits, // <- source of truth for competition totals
        lastSettlementVersion: settlementVersion,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  });
}

/**
 * Deterministically update competition DAY leaderboard for ONE user for ONE race:
 * - sets raceReturns[raceId] = raceReturn
 * - recomputes totalReturnInclStake = sum(raceReturns)
 *
 * Stored at:
 *   competitions/{competitionId}/leaderboardDays/{YYYY-MM-DD}/users/{userId}
 */
async function upsertCompetitionLeaderboardDayDeterministic({
  db,
  competitionId,
  day,
  userId,
  raceId,
  raceReturn,
  settlementVersion,
}) {
  const safeDay = normalizeDayKey(day);

  if (!safeDay) {
    logger.warn(
      `Skipping day leaderboard write: invalid day="${String(
        day ?? ""
      )}" competitionId=${competitionId} raceId=${raceId}`
    );
    return;
  }

  const ref = db
    .collection("competitions")
    .doc(competitionId)
    .collection("leaderboardDays")
    .doc(safeDay)
    .collection("users")
    .doc(userId);

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const existing = snap.exists ? snap.data() : {};

    const raceProfits = {
      ...(existing.raceProfits || existing.raceReturns || {}),
    };

    // Replace the per-race contribution (do NOT increment)
    raceProfits[raceId] = Number(raceReturn ?? 0);

    // Recompute total deterministically
    let total = 0;
    for (const v of Object.values(raceProfits)) {
      total += Number(v ?? 0);
    }

    tx.set(
      ref,
      {
        userId,
        competitionId,
        day: safeDay,
        totalProfit: total,
        // Backwards compatible field name used by the app UI:
        totalReturnInclStake: total,
        raceProfits,
        lastSettlementVersion: settlementVersion,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  });
}

exports.settleRaceOnResult = onDocumentWritten(
  {
    document: "results/{raceId}",
    region: "europe-west2",
  },
  async (event) => {
    // ... your existing settleRaceOnResult implementation continues unchanged ...
  }
);