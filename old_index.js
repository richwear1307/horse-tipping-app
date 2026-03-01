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
const { onDocumentWritten } = require("firebase-functions/v2/firestore");
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

    const raceProfits = { ...(existing.raceProfits || existing.raceReturns || {}) };

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
      `Skipping day leaderboard write: invalid day="${String(day ?? "")}" competitionId=${competitionId} raceId=${raceId}`
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

    const raceProfits = { ...(existing.raceProfits || existing.raceReturns || {}) };

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
    const after = event.data?.after;
    if (!after || !after.exists) return;

    const raceId = event.params.raceId;
    const result = after.data();

    const finishPositions = result.finishPositions || {};
    const placesPaid = Number(result.placesPaid ?? 3);
    const placeFraction = Number(result.eachWayFraction ?? 0.2);
    const competitionId = result.competitionId || null;

    // ✅ NEW: Non-runner + favourite data from result doc
    const nonRunners = new Set(
      (Array.isArray(result.nonRunners) ? result.nonRunners : [])
        .map((x) => String(x ?? "").trim())
        .filter(Boolean)
    );
    const favouriteHorseId = String(result.favouriteHorseId ?? "").trim();
    const favouriteHorseName = String(result.favouriteHorseName ?? "").trim() || null;

    if (nonRunners.size > 0 && !favouriteHorseId) {
      logger.warn(
        `Race ${raceId} has nonRunners but no favouriteHorseId. Non-runner swaps will be skipped.`
      );
    }

    const db = admin.firestore();
    const settlementRef = db.collection("raceSettlements").doc(raceId);
    const usersSubcolRef = settlementRef.collection("users");

    // --------------------------------------------------
    // Backfill map: horseName -> horseId (race runners)
    // --------------------------------------------------
    let horseNameToId = null;
    let raceDay = null;

    try {
      const raceSnap = await db.doc(`races/${raceId}`).get();
      if (raceSnap.exists) {
        const race = raceSnap.data() || {};
        raceDay = normalizeDayKey(race.date);

        horseNameToId = new Map();
        (race.runners || []).forEach((r) => {
          if (!r?.horseName || !r?.horseId) return;
          horseNameToId.set(normName(r.horseName), String(r.horseId).trim());
        });

        if (!raceDay && race?.date) {
          logger.warn(
            `Race ${raceId} has non-ISO date="${String(race.date)}" - day leaderboard will be skipped until fixed (recommended: store YYYY-MM-DD).`
          );
        }
      }
    } catch (err) {
      logger.error(`Failed to load race runners for ${raceId}`, err);
    }

    // ------------------------------------------
    // 2) Build officialOddsByHorseId from result
    // ------------------------------------------
    const officialOddsByHorseId = {};
    const officialOddsDecimalByHorseId = {};

    try {
      if (Array.isArray(result.placements) && result.placements.length > 0) {
        let nameToId = null;

        for (const p of result.placements) {
          let horseId = String(p?.horseId ?? "").trim();

          if (!horseId) {
            if (!nameToId) {
              const raceSnap = await db.doc(`races/${raceId}`).get();
              const race = raceSnap.exists ? (raceSnap.data() || {}) : {};

              nameToId = new Map();
              (race.runners || []).forEach((r) => {
                if (!r?.horseName || !r?.horseId) return;
                nameToId.set(normName(r.horseName), String(r.horseId).trim());
              });
            }

            const nameKey = normName(p?.horseName);
            horseId = nameToId.get(nameKey) || "";
          }

          if (!horseId) {
            logger.warn(
              `Could not determine horseId for placement in race ${raceId}: horseName="${p?.horseName}" horseId="${p?.horseId}"`
            );
            continue;
          }

          const oddsDisplay = String(p?.oddsDisplay ?? p?.oddsInput ?? "").trim();
          if (oddsDisplay) officialOddsByHorseId[horseId] = oddsDisplay;

          const od = p?.oddsDecimal;
          if (typeof od === "number" && Number.isFinite(od) && od > 1) {
            officialOddsDecimalByHorseId[horseId] = od;
          }
        }

        logger.info(
          `Built official odds map for race ${raceId}. entries=${Object.keys(officialOddsByHorseId).length}`
        );
      } else {
        logger.info(`No placements on result for race ${raceId}; no official odds map built.`);
      }
    } catch (err) {
      logger.error(`Failed building official odds map for race ${raceId}`, err);
    }

    // --------------------------------------------------
    // Backfill map from RESULTS placements (preferred)
    // tip.horseName -> horseId using result.placements
    // --------------------------------------------------
    const placementNameToHorseId = new Map();
    try {
      if (Array.isArray(result.placements)) {
        result.placements.forEach((p) => {
          if (!p?.horseId || !p?.horseName) return;
          placementNameToHorseId.set(normName(p.horseName), String(p.horseId).trim());
        });
      }
    } catch (err) {
      logger.error(`Failed building placementNameToHorseId map for race ${raceId}`, err);
    }

    // -------------------------
    // 1) Acquire a simple lock
    // -------------------------
    const runId = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const lockMs = 2 * 60 * 1000;

    const { settlementVersion } = await db.runTransaction(async (tx) => {
      const snap = await tx.get(settlementRef);
      const data = snap.exists ? snap.data() : {};

      const now = Date.now();
      const lockedUntil = data?.lockedUntilMs || 0;
      const status = data?.status;

      if (status === "settling" && lockedUntil > now) {
        throw new Error(`Settlement is already running for race ${raceId} (lock active)`);
      }

      const currentVersion = Number(data?.settlementVersion ?? 0);

      tx.set(
        settlementRef,
        {
          raceId,
          competitionId,
          status: "settling",
          runId,
          lockedUntilMs: now + lockMs,
          favouriteHorseId: favouriteHorseId || null,
          favouriteHorseName,
          nonRunners: Array.from(nonRunners),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      return { settlementVersion: currentVersion };
    });

    logger.info(`Settling race ${raceId} runId=${runId} version=${settlementVersion}`);

    // ------------------------------------------
    // 2) Load existing user settlements (old)
    // ------------------------------------------
    const existingSettSnap = await usersSubcolRef.get();
    const oldByUserId = new Map();
    existingSettSnap.forEach((doc) => {
      const d = doc.data() || {};
      const oldVal = Number(d.totalReturnInclStake ?? 0);
      const oldProfit = Number(d.totalProfit ?? 0);
      oldByUserId.set(doc.id, { oldVal, oldProfit, docRef: doc.ref, data: d });
    });

    // ------------------------------------------
    // 3) Load current tips for this race
    // ------------------------------------------
    const tipsSnap = await db.collection("tips").where("raceId", "==", raceId).get();

    logger.info(`Found ${tipsSnap.size} tips for race ${raceId}`);

    const newByUserId = new Map();
    let tipsSkipped = 0;
    let swapsApplied = 0;

    tipsSnap.forEach((tipDoc) => {
      const tip = tipDoc.data() || {};

      const userId = String(tip.userId ?? "").trim();
      let horseId = String(tip.horseId ?? "").trim();

      if (!userId) {
        tipsSkipped++;
        logger.warn(`Skipping tip ${tipDoc.id} - missing userId`);
        return;
      }

      if (!horseId && tip.horseName) {
        horseId = placementNameToHorseId.get(normName(tip.horseName)) || "";
      }

      if (!horseId && tip.horseName && horseNameToId) {
        horseId = horseNameToId.get(normName(tip.horseName)) || "";
      }

      if (!horseId) {
        tipsSkipped++;
        logger.warn(
          `Skipping tip ${tipDoc.id} - could not resolve horseId (horseName="${tip.horseName}")`
        );
        return;
      }

      const originalHorseId = horseId;
      let effectiveHorseId = horseId;
      let wasNonRunnerSwap = false;

      if (nonRunners.size > 0 && nonRunners.has(originalHorseId)) {
        if (favouriteHorseId) {
          effectiveHorseId = favouriteHorseId;
          wasNonRunnerSwap = true;
          swapsApplied++;
        } else {
          logger.warn(
            `Non-runner swap skipped (no favouriteHorseId). raceId=${raceId} userId=${userId} originalHorseId=${originalHorseId}`
          );
        }
      }

      const finishPosition = finishPositions[effectiveHorseId] ?? 999;

      const officialOddsRaw = officialOddsByHorseId[effectiveHorseId] || "";
      const officialOddsDec = officialOddsDecimalByHorseId[effectiveHorseId];

      const oddsSourceRaw = officialOddsRaw || tip.odds;

      const odds =
        typeof officialOddsDec === "number" &&
        Number.isFinite(officialOddsDec) &&
        officialOddsDec > 1
          ? officialOddsDec
          : parseOdds(oddsSourceRaw);

      if (!Number.isFinite(odds)) {
        tipsSkipped++;
        logger.warn(
          `Skipping tip ${tipDoc.id} - could not parse odds. official="${officialOddsRaw}" tip="${tip.odds}"`
        );
        return;
      }

      const returns = calcEachWayTotalReturnInclStake({
        odds,
        finishPosition,
        placeFraction,
        placesPaid,
      });

      const profit = calcEachWayProfit({
        odds,
        finishPosition,
        placeFraction,
        placesPaid,
      });

      const settlementOddsDisplay = String(oddsSourceRaw ?? "").trim();

      newByUserId.set(userId, {
        userId,
        raceId,
        competitionId,
        tipDocId: tipDoc.id,
        originalHorseId,
        effectiveHorseId,
        wasNonRunnerSwap,
        favouriteHorseId: favouriteHorseId || null,
        horseId: effectiveHorseId,
        finishPosition,
        odds: settlementOddsDisplay,
        oddsDecimal: odds,
        oddsRaw: settlementOddsDisplay,
        placesPaid,
        placeFraction,
        totalReturnInclStake: returns.totalReturnInclStake,
        totalProfit: profit.totalProfit,
        winProfit: profit.winProfit,
        placeProfit: profit.placeProfit,
        winReturn: returns.winReturn,
        placeReturn: returns.placeReturn,
        winWinnings: returns.winWinnings,
        placeWinnings: returns.placeWinnings,
      });
    });

    // ------------------------------------------
    // 4) Settlement + user aggregate writes (delta)
    // ------------------------------------------
    const nextVersion = Number(settlementVersion ?? 0) + 1;

    const writes = [];
    let tipsWritten = 0;
    let tipsRemoved = 0;
    let totalDeltaAppliedUsers = 0;

    const compLeaderboardWork = [];

    for (const [userId, newSettle] of newByUserId.entries()) {
      const old = oldByUserId.get(userId);
      const oldVal = old ? Number(old.oldVal ?? 0) : 0;
      const oldProfit = old ? Number(old.oldProfit ?? 0) : 0;
      const newVal = Number(newSettle.totalReturnInclStake ?? 0);
      const newProfit = Number(newSettle.totalProfit ?? 0);
      const delta = newVal - oldVal;
      const deltaProfit = newProfit - oldProfit;

      const userSettlementRef = usersSubcolRef.doc(userId);
      const userAggRef = db.collection("users").doc(userId);

      writes.push((batch) => {
        batch.set(
          userSettlementRef,
          {
            ...newSettle,
            settlementVersion: nextVersion,
            settledAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );

        if (delta !== 0 || deltaProfit !== 0) {
          batch.set(
            userAggRef,
            {
              totalReturnInclStake: admin.firestore.FieldValue.increment(delta),
              totalProfit: admin.firestore.FieldValue.increment(deltaProfit),
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true }
          );
        }
      });

      if (competitionId) {
        compLeaderboardWork.push({ userId, raceProfit: newProfit });
      }

      tipsWritten++;
      if (delta !== 0) totalDeltaAppliedUsers++;
    }

    for (const [userId, oldInfo] of oldByUserId.entries()) {
      if (newByUserId.has(userId)) continue;

      const oldVal = Number(oldInfo.oldVal ?? 0);
      const userAggRef = db.collection("users").doc(userId);

      writes.push((batch) => {
        if (oldVal !== 0) {
          batch.set(
            userAggRef,
            {
              totalReturnInclStake: admin.firestore.FieldValue.increment(-oldVal),
              totalProfit: admin.firestore.FieldValue.increment(-(Number(oldInfo.oldProfit ?? 0))),
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true }
          );
        }

        batch.delete(oldInfo.docRef);
      });

      if (competitionId) {
        compLeaderboardWork.push({ userId, raceProfit: 0 });
      }

      tipsRemoved++;
      if (oldVal !== 0) totalDeltaAppliedUsers++;
    }

    writes.push((batch) => {
      batch.set(
        settlementRef,
        {
          status: "settled",
          settlementVersion: nextVersion,
          tipsFound: tipsSnap.size,
          tipsWritten,
          tipsSkipped,
          tipsRemoved,
          swapsApplied,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          settledAt: admin.firestore.FieldValue.serverTimestamp(),
          lockedUntilMs: 0,
        },
        { merge: true }
      );
    });

    await commitInChunks(writes, 450);

    logger.info(
      `Race ${raceId} settled. version=${nextVersion} tipsWritten=${tipsWritten} tipsRemoved=${tipsRemoved} tipsSkipped=${tipsSkipped} usersDelta=${totalDeltaAppliedUsers} competitionId=${competitionId}`
    );

    // ------------------------------------------
    // 6) Competition leaderboards: deterministic per-race value
    // ------------------------------------------
    if (competitionId && compLeaderboardWork.length > 0) {
      for (const item of compLeaderboardWork) {
        try {
          await upsertCompetitionLeaderboardDeterministic({
            db,
            competitionId,
            userId: item.userId,
            raceId,
            raceReturn: item.raceProfit,
            settlementVersion: nextVersion,
          });

          if (raceDay) {
            await upsertCompetitionLeaderboardDayDeterministic({
              db,
              competitionId,
              day: raceDay,
              userId: item.userId,
              raceId,
              raceReturn: item.raceProfit,
              settlementVersion: nextVersion,
            });
          }
        } catch (err) {
          logger.error(
            `Competition leaderboard update failed competitionId=${competitionId} raceId=${raceId} userId=${item.userId}`,
            err
          );
        }
      }

      logger.info(
        `Competition leaderboard updates complete. competitionId=${competitionId} raceId=${raceId} users=${compLeaderboardWork.length}`
      );

      try {
        await db
          .collection("competitions")
          .doc(competitionId)
          .collection("leaderboardCalcLogs")
          .doc(runId)
          .set(
            {
              runId,
              raceId,
              day: raceDay ?? null,
              settlementVersion: nextVersion,
              usersUpdated: compLeaderboardWork.length,
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true }
          );
      } catch (err) {
        logger.error(
          `Failed writing leaderboardCalcLogs competitionId=${competitionId} runId=${runId}`,
          err
        );
      }
    }
  }
);
