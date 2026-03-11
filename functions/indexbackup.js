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
 *
 * ✅ EXTRA FIX (NEW):
 * - Derive the day directly from raceId if possible (raceId starts with YYYY-MM-DD_...)
 *   This avoids missing/invalid date fields on race/result documents.
 *
 * ✅ EXTRA FIX (CORS):
 * - For Expo Web, Gen2 callables must return CORS headers.
 * - We enable cors on all onCall functions used by the web client.
 */

"use strict";

// ------------------------------
// Gen2 imports + global options
// ------------------------------
const { setGlobalOptions } = require("firebase-functions/v2");
const logger = require("firebase-functions/logger");
const {
  onDocumentWritten,
  onDocumentUpdated, // ✅ for seeding on registration
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

// ------------------------------
// ✅ Auth/PIN helpers
// ------------------------------
const crypto = require("crypto");

/**
 * Normalize user-entered usernames into a Firestore-safe key:
 * - trim + lowercase
 * - convert any whitespace run to "-"
 * - remove any chars not in [a-z0-9._-]
 * - collapse multiple "-" to single "-"
 */
function normalizeUsernameKey(username) {
  return String(username || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9._-]/g, "")
    .replace(/-+/g, "-");
}

/** Validate PIN is 4–6 digits */
function assertValidPin(pin) {
  const s = String(pin || "");
  if (!/^\d{4,6}$/.test(s)) {
    throw new HttpsError("invalid-argument", "PIN must be 4–6 digits");
  }
  return s;
}

/**
 * Derive a hash using scrypt (slow KDF). Store:
 * - pinSalt (base64)
 * - pinHash (base64)
 *
 * NOTE: This uses sync scrypt for simplicity; fine for low volume.
 * If you expect high auth volume, switch to crypto.scrypt (async).
 */
function hashPinScrypt(pin, saltBuf) {
  const key = crypto.scryptSync(pin, saltBuf, 64, { N: 16384, r: 8, p: 1 });
  return key.toString("base64");
}

function timingSafeEqualB64(aB64, bB64) {
  const a = Buffer.from(String(aB64 || ""), "base64");
  const b = Buffer.from(String(bB64 || ""), "base64");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function newRandomTokenB64url(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}

function hashTokenSha256B64(token) {
  return crypto.createHash("sha256").update(token).digest("base64");
}

// ✅ CORS helper for Gen2 callable functions (Expo Web)
const CALLABLE_BASE = {
  region: "europe-west2",
  cors: true, // ✅ fixes Expo Web CORS preflight on callable endpoints
};

/**
 * Callable: Send a custom-branded magic sign-in link email via IONOS SMTP.
 *
 * NOTE:
 * This function generates a Firebase Auth email-link sign-in URL.
 * If you're moving to "username + PIN" accounts (custom token auth),
 * prefer implementing a custom magic-link flow (token you generate + consume).
 */
exports.sendMagicLink = onCall(
  {
    ...CALLABLE_BASE,
    secrets: [SMTP_CONFIG],
  },
  async (request) => {
    const email = String(request.data?.email || "").trim().toLowerCase();
    logger.info("sendMagicLink invoked", { email });
    if (!email) throw new HttpsError("invalid-argument", "Email required");

    const actionCodeSettings = {
      url: "https://tcctips.com",
      handleCodeInApp: true,
    };

    const link = await admin
      .auth()
      .generateSignInWithEmailLink(email, actionCodeSettings);

    const { host, port, user, pass, from } = SMTP_CONFIG.value();

    const transporter = nodemailer.createTransport({
      host,
      port: Number(port || 587),
      secure: Number(port) === 465,
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
// ✅ Username + PIN auth (custom token) + custom magic link (by username)
// -----------------------------------------------------------------------------

/**
 * Callable: Sign up with Username + PIN (+ optional email)
 *
 * Creates:
 *   usernames/{usernameKey} -> { uid }
 *   users/{uid} -> profile + pinHash/salt
 *
 * Returns:
 *   { token, uid }
 */
exports.authSignUp = onCall(
  { ...CALLABLE_BASE },
  async (request) => {
    const db = admin.firestore();

    const username = String(request.data?.username || "").trim();
    const usernameKey = normalizeUsernameKey(username);
    const pin = assertValidPin(request.data?.pin);

    // email optional
    const emailRaw = request.data?.email;
    const email = emailRaw ? String(emailRaw).trim().toLowerCase() : null;

    if (!usernameKey) {
      throw new HttpsError("invalid-argument", "Username required");
    }

    // Create a new uid (also used as users/{uid} doc id)
    const uid = db.collection("users").doc().id;

    const unameRef = db.collection("usernames").doc(usernameKey);
    const userRef = db.collection("users").doc(uid);

    const salt = crypto.randomBytes(16);
    const pinHash = hashPinScrypt(pin, salt);

    // Enforce unique username via transaction
    await db.runTransaction(async (tx) => {
      const unameSnap = await tx.get(unameRef);
      if (unameSnap.exists) {
        throw new HttpsError("already-exists", "Username already taken");
      }

      tx.set(unameRef, { uid }, { merge: false });

      tx.set(
        userRef,
        {
          uid,
          username,
          usernameKey,
          email: email || null,

          pinHash,
          pinSalt: salt.toString("base64"),

          failedPinAttempts: 0,
          pinLockUntil: null,

          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: false }
      );
    });

    // Mint a Firebase custom token (Firebase Auth user will be created on first sign-in)
    const token = await admin.auth().createCustomToken(uid);
    return { token, uid };
  }
);

/**
 * Callable: Login with Username + PIN
 *
 * Returns:
 *   { token, uid }
 *
 * Security:
 * - account lockout after repeated failures (fields on users/{uid})
 */
exports.authSignInWithPin = onCall(
  { ...CALLABLE_BASE },
  async (request) => {
    const db = admin.firestore();

    const usernameKey = normalizeUsernameKey(request.data?.username);
    const pin = assertValidPin(request.data?.pin);

    if (!usernameKey) {
      throw new HttpsError("invalid-argument", "Username required");
    }

    const unameRef = db.collection("usernames").doc(usernameKey);
    const unameSnap = await unameRef.get();

    // Avoid revealing whether a username exists
    if (!unameSnap.exists) {
      throw new HttpsError("permission-denied", "Invalid credentials");
    }

    const { uid } = unameSnap.data() || {};
    if (!uid) {
      throw new HttpsError("permission-denied", "Invalid credentials");
    }

    const userRef = db.collection("users").doc(uid);

    // Verify PIN + apply lockout rules inside a transaction
    await db.runTransaction(async (tx) => {
      const userSnap = await tx.get(userRef);
      if (!userSnap.exists) {
        throw new HttpsError("permission-denied", "Invalid credentials");
      }

      const u = userSnap.data() || {};
      const now = Date.now();

      const lockUntilMs =
        u.pinLockUntil?.toMillis && typeof u.pinLockUntil.toMillis === "function"
          ? u.pinLockUntil.toMillis()
          : 0;

      if (lockUntilMs && lockUntilMs > now) {
        throw new HttpsError(
          "resource-exhausted",
          "Too many attempts. Try again later."
        );
      }

      const saltB64 = String(u.pinSalt || "");
      const storedHashB64 = String(u.pinHash || "");

      if (!saltB64 || !storedHashB64) {
        // User has no PIN set
        throw new HttpsError("permission-denied", "Invalid credentials");
      }

      const salt = Buffer.from(saltB64, "base64");
      const computedHashB64 = hashPinScrypt(pin, salt);

      const ok = timingSafeEqualB64(computedHashB64, storedHashB64);

      if (!ok) {
        const failed = Number(u.failedPinAttempts || 0) + 1;

        // Backoff lock policy
        // 1-4: no lock
        // 5: 5 min
        // 6: 15 min
        // 7+: 60 min
        let lockMs = 0;
        if (failed === 5) lockMs = 5 * 60 * 1000;
        else if (failed === 6) lockMs = 15 * 60 * 1000;
        else if (failed >= 7) lockMs = 60 * 60 * 1000;

        tx.set(
          userRef,
          {
            failedPinAttempts: failed,
            pinLockUntil: lockMs
              ? admin.firestore.Timestamp.fromMillis(now + lockMs)
              : null,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );

        throw new HttpsError("permission-denied", "Invalid credentials");
      }

      // Success: reset lock counters
      tx.set(
        userRef,
        {
          failedPinAttempts: 0,
          pinLockUntil: null,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    });

    const token = await admin.auth().createCustomToken(uid);
    return { token, uid };
  }
);

/**
 * Callable: Request a magic link by username (ONLY sends if user has email set)
 * Stores a one-time token hash + expiry on users/{uid}, emails the link via SMTP.
 *
 * Returns { ok:true } always (to avoid leaking which usernames exist).
 */
exports.authRequestMagicLink = onCall(
  {
    ...CALLABLE_BASE,
    secrets: [SMTP_CONFIG],
  },
  async (request) => {
    const db = admin.firestore();
    const usernameKey = normalizeUsernameKey(request.data?.username);

    // Always return ok to avoid username enumeration
    if (!usernameKey) return { ok: true };

    const unameSnap = await db.collection("usernames").doc(usernameKey).get();
    if (!unameSnap.exists) return { ok: true };

    const { uid } = unameSnap.data() || {};
    if (!uid) return { ok: true };

    const userRef = db.collection("users").doc(uid);
    const userSnap = await userRef.get();
    if (!userSnap.exists) return { ok: true };

    const user = userSnap.data() || {};
    const email = user.email ? String(user.email).trim().toLowerCase() : null;
    if (!email) return { ok: true };

    // Create one-time token and store only a hash
    const token = newRandomTokenB64url(32);
    const tokenHash = hashTokenSha256B64(token);
    const expiresAt = admin.firestore.Timestamp.fromMillis(
      Date.now() + 15 * 60 * 1000
    ); // 15 min

    await userRef.set(
      {
        magicLinkHash: tokenHash,
        magicLinkExpiresAt: expiresAt,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    const { host, port, user: smtpUser, pass, from } = SMTP_CONFIG.value();

    const transporter = nodemailer.createTransport({
      host,
      port: Number(port || 587),
      secure: Number(port) === 465,
      auth: { user: smtpUser, pass },
    });

    // Your web route should read u + t and call authConsumeMagicLink
    const link = `https://tcctips.com/magic?u=${encodeURIComponent(
      usernameKey
    )}&t=${encodeURIComponent(token)}`;

    await transporter.sendMail({
      from: from || `"Thoronton CC Cheltenham Tipping Competition" <${smtpUser}>`,
      to: email,
      subject: "Your sign-in link",
      html: `
        <p>Hello,</p>
        <p>Click below to sign in:</p>
        <p>
          <a href="${link}" style="display:inline-block;padding:12px 18px;text-decoration:none;border-radius:8px;font-weight:700;">
            Sign in to TCC Tipping Competition
          </a>
        </p>
        <p>This link expires in 15 minutes and can only be used once.</p>
        <p>If you didn’t request this, you can ignore this email.</p>
      `,
    });

    return { ok: true };
  }
);

/**
 * Callable: Consume a magic link (usernameKey + token) and return a custom token.
 * One-time use: clears magicLinkHash + magicLinkExpiresAt after success.
 *
 * Returns:
 *   { token, uid }
 */
exports.authConsumeMagicLink = onCall(
  { ...CALLABLE_BASE },
  async (request) => {
    const db = admin.firestore();

    const usernameKey = normalizeUsernameKey(request.data?.usernameKey);
    const token = String(request.data?.token || "");

    if (!usernameKey || !token) {
      throw new HttpsError("invalid-argument", "Invalid link");
    }

    const unameSnap = await db.collection("usernames").doc(usernameKey).get();
    if (!unameSnap.exists) {
      throw new HttpsError("permission-denied", "Invalid link");
    }

    const { uid } = unameSnap.data() || {};
    if (!uid) {
      throw new HttpsError("permission-denied", "Invalid link");
    }

    const userRef = db.collection("users").doc(uid);
    const tokenHash = hashTokenSha256B64(token);

    await db.runTransaction(async (tx) => {
      const snap = await tx.get(userRef);
      if (!snap.exists) {
        throw new HttpsError("permission-denied", "Invalid link");
      }

      const u = snap.data() || {};

      const expMs =
        u.magicLinkExpiresAt?.toMillis &&
        typeof u.magicLinkExpiresAt.toMillis === "function"
          ? u.magicLinkExpiresAt.toMillis()
          : 0;

      if (!u.magicLinkHash || !expMs || expMs < Date.now()) {
        throw new HttpsError("permission-denied", "Link expired");
      }

      if (String(u.magicLinkHash) !== tokenHash) {
        throw new HttpsError("permission-denied", "Invalid link");
      }

      // One-time use: clear token
      tx.set(
        userRef,
        {
          magicLinkHash: admin.firestore.FieldValue.delete(),
          magicLinkExpiresAt: admin.firestore.FieldValue.delete(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    });

    const firebaseToken = await admin.auth().createCustomToken(uid);
    return { token: firebaseToken, uid };
  }
);

// -----------------------------------------------------------------------------
// ✅ Seed overall leaderboard entry as soon as a user is registered
// -----------------------------------------------------------------------------
exports.seedLeaderboardOnRegistration = onDocumentUpdated(
  {
    document: "users/{userId}",
    database: "(default)", // ✅ ensure correct Firestore DB
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

    const beforeSet = new Set(beforeIds.map(String));
    const added = afterIds.map(String).filter((id) => id && !beforeSet.has(id));
    if (added.length === 0) return;

    const db = admin.firestore();
    const displayNameLower = String(after.displayName || "").trim().toLowerCase();

    for (const competitionId of added) {
      const ref = db
        .collection("competitions")
        .doc(competitionId)
        .collection("leaderboard")
        .doc(userId);

      await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);

        if (!snap.exists) {
          tx.set(
            ref,
            {
              userId,
              competitionId,
              totalReturnInclStake: 0,
              totalProfit: 0,
              tips: 0,
              createdAt: admin.firestore.FieldValue.serverTimestamp(),
              displayNameLower,
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true }
          );
          return;
        }

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
 * ✅ NEW: Derive YYYY-MM-DD directly from a raceId if it starts with YYYY-MM-DD_
 * Example raceId: "2026-03-01_chelt_15:20" -> "2026-03-01"
 *
 * ✅ FIX: trim raceId first (protect against accidental whitespace)
 */
function dayFromRaceId(raceId) {
  const id = String(raceId || "").trim();
  const m = id.match(/^(\d{4}-\d{2}-\d{2})_/);
  return m ? m[1] : null;
}

/**
 * ✅ UPDATED: Normalize a date value into ISO "YYYY-MM-DD" suitable for a Firestore document id.
 */
function normalizeDayKey(value) {
  if (!value) return null;

  if (typeof value === "object") {
    try {
      if (typeof value.toDate === "function") {
        const d = value.toDate();
        return d.toISOString().slice(0, 10);
      }
      if (typeof value.seconds === "number") {
        const d = new Date(value.seconds * 1000);
        return d.toISOString().slice(0, 10);
      }
    } catch (_) {}
  }

  let s = String(value)
    .trim()
    .replace(/\u00A0/g, " ")
    .replace(/\r|\n/g, "");

  if (!s) return null;

  if (s.includes("T")) {
    const iso = s.split("T")[0];
    if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  let m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;

  m = s.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;

  m = s.match(/^(\d{4})\/(\d{2})\/(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;

  return null;
}

function parseOdds(raw) {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;

  if (typeof raw === "string") {
    const s = raw.trim();

    const asNum = Number(s);
    if (Number.isFinite(asNum) && asNum > 1) return asNum;

    const m = s.match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/);
    if (m) {
      const num = Number(m[1]);
      const den = Number(m[2]);
      if (Number.isFinite(num) && Number.isFinite(den) && den !== 0) {
        return 1 + num / den;
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

    raceProfits[raceId] = Number(raceReturn ?? 0);

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
        totalReturnInclStake: total,
        raceProfits,
        lastSettlementVersion: settlementVersion,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  });
}

/**
 * ✅ FIXED: creates the parent day document so leaderboardDays queries return docs.
 *
 * ✅ IMPORTANT FIX (NEW):
 * Firestore transactions require *all reads before all writes*.
 * So we tx.get(userRef) BEFORE any tx.set().
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

  const dayRef = db
    .collection("competitions")
    .doc(competitionId)
    .collection("leaderboardDays")
    .doc(safeDay);

  const userRef = dayRef.collection("users").doc(userId);

  await db.runTransaction(async (tx) => {
    // ✅ READ FIRST (required by Firestore transaction rules)
    const snap = await tx.get(userRef);
    const existing = snap.exists ? snap.data() : {};

    const raceProfits = {
      ...(existing.raceProfits || existing.raceReturns || {}),
    };

    raceProfits[raceId] = Number(raceReturn ?? 0);

    let total = 0;
    for (const v of Object.values(raceProfits)) {
      total += Number(v ?? 0);
    }

    // ✅ WRITES AFTER READS
    tx.set(
      dayRef,
      {
        competitionId,
        day: safeDay,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    tx.set(
      userRef,
      {
        userId,
        competitionId,
        day: safeDay,
        totalProfit: total,
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
    database: "(default)", // ✅ ensure correct Firestore DB
    region: "europe-west2",
  },
  async (event) => {
    const after = event.data?.after;

    // ✅ Helpful marker so you never have an empty settlement doc again
    const raceId = event.params.raceId;
    const db = admin.firestore();
    const settlementRef = db.collection("raceSettlements").doc(raceId);

    if (!after || !after.exists) {
      logger.info(`Result deleted for race ${raceId}. Rolling back previous settlement.`);

      const before = event.data?.before;
      const previousResult = before?.exists ? before.data() || {} : {};

      const previousCompetitionId = previousResult.competitionId || null;

      // Best-effort day derivation for removing per-day leaderboard contribution
      let rollbackRaceDay = dayFromRaceId(raceId);

      try {
        if (!rollbackRaceDay) {
          const raceSnap = await db.doc(`races/${raceId}`).get();
          if (raceSnap.exists) {
            const race = raceSnap.data() || {};
            rollbackRaceDay = normalizeDayKey(race.date);
          }
        }

        if (!rollbackRaceDay) {
          rollbackRaceDay = normalizeDayKey(previousResult.date);
        }
      } catch (err) {
        logger.error(`Failed deriving rollback day for race ${raceId}`, err);
      }

      const usersSubcolRef = settlementRef.collection("users");
      const existingSettSnap = await usersSubcolRef.get();

      const writes = [];
      const compLeaderboardWork = [];

      let usersRolledBack = 0;
      let tipsRemoved = 0;

      existingSettSnap.forEach((docSnap) => {
        const d = docSnap.data() || {};
        const userId = docSnap.id;

        const oldVal = Number(d.totalReturnInclStake ?? 0);
        const oldProfit = Number(d.totalProfit ?? 0);

        const userAggRef = db.collection("users").doc(userId);

        writes.push((batch) => {
          if (oldVal !== 0 || oldProfit !== 0) {
            batch.set(
              userAggRef,
              {
                totalReturnInclStake: admin.firestore.FieldValue.increment(-oldVal),
                totalProfit: admin.firestore.FieldValue.increment(-oldProfit),
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
              },
              { merge: true }
            );
          }

          batch.delete(docSnap.ref);
        });

        if (previousCompetitionId) {
          compLeaderboardWork.push({ userId, raceReturn: 0, raceProfit: 0 });
        }

        usersRolledBack++;
        if (oldVal !== 0 || oldProfit !== 0) {
          tipsRemoved++;
        }
      });

      writes.push((batch) => {
        batch.set(
          settlementRef,
          {
            raceId,
            competitionId: previousCompetitionId,
            status: "cleared_no_result",
            tipsRemoved,
            usersRolledBack,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            clearedAt: admin.firestore.FieldValue.serverTimestamp(),
            lockedUntilMs: 0,
          },
          { merge: true }
        );
      });

      await commitInChunks(writes, 450);

      logger.info(
        `Rollback complete for deleted result raceId=${raceId} usersRolledBack=${usersRolledBack} competitionId=${previousCompetitionId}`
      );

      if (previousCompetitionId && compLeaderboardWork.length > 0) {
        const settlementSnap = await settlementRef.get();
        const settlementData = settlementSnap.exists ? settlementSnap.data() || {} : {};
        const rollbackVersion = Number(settlementData.settlementVersion ?? 0) + 1;

        await settlementRef.set(
          {
            settlementVersion: rollbackVersion,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );

        for (const item of compLeaderboardWork) {
          try {
            await upsertCompetitionLeaderboardDeterministic({
              db,
              competitionId: previousCompetitionId,
              userId: item.userId,
              raceId,
              raceReturn: 0,
              settlementVersion: rollbackVersion,
            });

            if (rollbackRaceDay) {
              await upsertCompetitionLeaderboardDayDeterministic({
                db,
                competitionId: previousCompetitionId,
                day: rollbackRaceDay,
                userId: item.userId,
                raceId,
                raceReturn: 0,
                settlementVersion: rollbackVersion,
              });
            }
          } catch (err) {
            logger.error(
              `Rollback leaderboard update failed competitionId=${previousCompetitionId} raceId=${raceId} userId=${item.userId}`,
              err
            );
          }
        }
      }

      // REMOVE AUTO-ASSIGNED TIPS
      try {
        const autoTipsSnap = await db
          .collection("tips")
          .where("raceId", "==", raceId)
          .where("autoAssigned", "==", true)
          .get();

        if (!autoTipsSnap.empty) {
          const batch = db.batch();

          autoTipsSnap.forEach((docSnap) => {
            batch.delete(docSnap.ref);
          });

          await batch.commit();

          logger.info(
            `Removed ${autoTipsSnap.size} auto-assigned tips for race ${raceId}`
          );
        }
      } catch (err) {
        logger.error(`Failed removing auto-assigned tips for race ${raceId}`, err);
      }

      return;
    }

    const result = after.data();

    const finishPositions = result.finishPositions || {};
    const placesPaid = Number(result.placesPaid ?? 3);
    const placeFraction = Number(result.eachWayFraction ?? 0.2);
    const competitionId = result.competitionId || null;

    const nonRunners = new Set(
      (Array.isArray(result.nonRunners) ? result.nonRunners : [])
        .map((x) => String(x ?? "").trim())
        .filter(Boolean)
    );
    const favouriteHorseId = String(result.favouriteHorseId ?? "").trim();
    const favouriteHorseName =
      String(result.favouriteHorseName ?? "").trim() || null;

    if (nonRunners.size > 0 && !favouriteHorseId) {
      logger.warn(
        `Race ${raceId} has nonRunners but no favouriteHorseId. Non-runner swaps will be skipped.`
      );
    }

    const usersSubcolRef = settlementRef.collection("users");

    let horseNameToId = null;
    let raceDay = null;

    try {
      const raceSnap = await db.doc(`races/${raceId}`).get();

      let rawRaceDate = null;

      // ✅ NEW: most reliable source: raceId prefix
      raceDay = dayFromRaceId(raceId);

      logger.info("DAY DEBUG", {
        raceIdRaw: raceId,
        raceIdLength: String(raceId || "").length,
        derivedDay: raceDay,
      });

      if (raceSnap.exists) {
        const race = raceSnap.data() || {};
        rawRaceDate = race.date ?? null;

        // ✅ Prefer raceId-derived day, otherwise use race.date
        if (!raceDay) {
          raceDay = normalizeDayKey(race.date);
        }

        // Build horseName -> horseId map (for older tips without horseId)
        horseNameToId = new Map();
        (race.runners || []).forEach((r) => {
          if (!r?.horseName || !r?.horseId) return;
          horseNameToId.set(normName(r.horseName), String(r.horseId).trim());
        });
      }

      // ✅ Fallback to result.date if still missing/invalid
      if (!raceDay) {
        raceDay = normalizeDayKey(result.date);
        logger.info("Using result.date fallback for raceDay", {
          raceId,
          resultDate: result.date ?? null,
          normalized: raceDay,
        });
      }

      // ✅ Debug log that will never throw
      logger.info("Race day normalization", {
        raceId,
        raceDocExists: raceSnap.exists,
        rawRaceDate,
        resultDate: result.date ?? null,
        fromRaceId: dayFromRaceId(raceId),
        normalized: raceDay,
      });

      // If we still can't normalize, warn loudly
      if (!raceDay) {
        logger.warn("Day leaderboard will be skipped (could not normalize day)", {
          raceId,
          rawRaceDate,
          resultDate: result.date ?? null,
          competitionId,
        });
      }
    } catch (err) {
      logger.error(`Failed to load race runners for ${raceId}`, err);
    }

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
              const race = raceSnap.exists ? raceSnap.data() || {} : {};

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
        logger.info(
          `No placements on result for race ${raceId}; no official odds map built.`
        );
      }
    } catch (err) {
      logger.error(`Failed building official odds map for race ${raceId}`, err);
    }

    const placementNameToHorseId = new Map();
    try {
      if (Array.isArray(result.placements)) {
        result.placements.forEach((p) => {
          if (!p?.horseId || !p?.horseName) return;
          placementNameToHorseId.set(normName(p.horseName), String(p.horseId).trim());
        });
      }
    } catch (err) {
      logger.error(
        `Failed building placementNameToHorseId map for race ${raceId}`,
        err
      );
    }

    const runId = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const lockMs = 2 * 60 * 1000;

    const { settlementVersion } = await db.runTransaction(async (tx) => {
      const snap = await tx.get(settlementRef);
      const data = snap.exists ? snap.data() : {};

      const now = Date.now();
      const lockedUntil = data?.lockedUntilMs || 0;
      const status = data?.status;

      if (status === "settling" && lockedUntil > now) {
        throw new Error(
          `Settlement is already running for race ${raceId} (lock active)`
        );
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

    logger.info(
      `Settling race ${raceId} runId=${runId} version=${settlementVersion}`
    );

    const existingSettSnap = await usersSubcolRef.get();
    const oldByUserId = new Map();
    existingSettSnap.forEach((doc) => {
      const d = doc.data() || {};
      const oldVal = Number(d.totalReturnInclStake ?? 0);
      const oldProfit = Number(d.totalProfit ?? 0);
      oldByUserId.set(doc.id, { oldVal, oldProfit, docRef: doc.ref, data: d });
    });

    let tipsSnap = await db
      .collection("tips")
      .where("raceId", "==", raceId)
      .get();

    logger.info(`Found ${tipsSnap.size} tips for race ${raceId}`);

    // ----------------------------------------------------
    // AUTO-ASSIGN FAVOURITE TO USERS WITH NO SELECTION
    // ----------------------------------------------------

    if (competitionId && favouriteHorseId) {
      const usersSnap = await db.collection("users").get();

      const registeredUsers = usersSnap.docs.filter((doc) => {
        const u = doc.data() || {};
        const comps = Array.isArray(u.registeredCompetitionIds)
          ? u.registeredCompetitionIds
          : [];
        return comps.includes(competitionId);
      });

      const existingTipUsers = new Set();

      tipsSnap.forEach((doc) => {
        const tip = doc.data() || {};
        if (tip.userId) {
          existingTipUsers.add(String(tip.userId));
        }
      });

      const batch = db.batch();
      let autoAssignedCount = 0;

      const raceSnap = await db.doc(`races/${raceId}`).get();
      const race = raceSnap.exists ? raceSnap.data() || {} : {};

      for (const userDoc of registeredUsers) {
        const user = userDoc.data() || {};
        const uid = userDoc.id;

        if (existingTipUsers.has(uid)) continue;

        const tipRef = db.collection("tips").doc(`${uid}_${raceId}`);

        batch.set(
          tipRef,
          {
            userId: uid,
            userEmail: String(user.email ?? ""),
            raceId,
            raceName: String(race.name ?? ""),
            date: String(raceId).slice(0, 10),
            horseId: favouriteHorseId,
            horseName: favouriteHorseName,
            odds: String(result.favouriteOdds ?? ""),
            lockAt: Number(race.lockAt ?? 0),
            autoAssigned: true,
            autoAssignedReason: "no_selection_assigned_favourite",
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
          { merge: true }
        );

        autoAssignedCount++;
      }

      if (autoAssignedCount > 0) {
        await batch.commit();

        logger.info(`Auto-assigned favourite to ${autoAssignedCount} users for race ${raceId}`);

        // 🔁 IMPORTANT: reload tips so settlement sees them
        tipsSnap = await db
          .collection("tips")
          .where("raceId", "==", raceId)
          .get();

        logger.info(`Tips after auto-assignment: ${tipsSnap.size}`);
      }
    }

    // ✅ marker if no tips — you will see it in Firestore
    if (tipsSnap.size === 0) {
      await settlementRef.set(
        {
          status: "skipped_no_tips",
          tipsFound: 0,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
      return;
    }

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
        compLeaderboardWork.push({
          userId,
          raceReturn: newVal,
          raceProfit: newProfit,
        });
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
              totalProfit: admin.firestore.FieldValue.increment(
                -(Number(oldInfo.oldProfit ?? 0))
              ),
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true }
          );
        }

        batch.delete(oldInfo.docRef);
      });

      if (competitionId) {
        compLeaderboardWork.push({
          userId,
          raceReturn: 0,
          raceProfit: 0,
        });
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

    if (competitionId && compLeaderboardWork.length > 0) {
      for (const item of compLeaderboardWork) {
        try {
          await upsertCompetitionLeaderboardDeterministic({
            db,
            competitionId,
            userId: item.userId,
            raceId,
            raceReturn: item.raceReturn,
            settlementVersion: nextVersion,
          });

          if (raceDay) {
            await upsertCompetitionLeaderboardDayDeterministic({
              db,
              competitionId,
              day: raceDay,
              userId: item.userId,
              raceId,
              raceReturn: item.raceReturn,
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