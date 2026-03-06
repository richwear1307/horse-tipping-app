const admin = require("firebase-admin");
const crypto = require("crypto");

// Adjust this path if needed
const serviceAccount = require("./serviceAccountKey.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

function normalizeUsernameKey(username) {
  return String(username || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9._-]/g, "")
    .replace(/-+/g, "-");
}

function hashPinScrypt(pin, saltBuf) {
  const key = crypto.scryptSync(pin, saltBuf, 64, { N: 16384, r: 8, p: 1 });
  return key.toString("base64");
}

async function main() {
  const username = process.argv[2];
  const newPin = process.argv[3];

  if (!username || !newPin) {
    console.error("Usage: node reset-pin.js <username> <newPin>");
    process.exit(1);
  }

  if (!/^\d{4,6}$/.test(String(newPin))) {
    console.error("PIN must be 4–6 digits.");
    process.exit(1);
  }

  const usernameKey = normalizeUsernameKey(username);

  try {
    const usernameRef = db.collection("usernames").doc(usernameKey);
    const usernameSnap = await usernameRef.get();

    if (!usernameSnap.exists) {
      console.error(`No username doc found for "${username}" (${usernameKey}).`);
      process.exit(1);
    }

    const { uid } = usernameSnap.data() || {};
    if (!uid) {
      console.error(`Username "${username}" has no uid.`);
      process.exit(1);
    }

    const salt = crypto.randomBytes(16);
    const pinHash = hashPinScrypt(String(newPin), salt);
    const pinSalt = salt.toString("base64");

    const userRef = db.collection("users").doc(uid);

    await userRef.set(
      {
        pinHash,
        pinSalt,
        failedPinAttempts: 0,
        pinLockUntil: null,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    console.log("PIN reset successful.");
    console.log("username:", username);
    console.log("usernameKey:", usernameKey);
    console.log("uid:", uid);
    console.log("newPin:", newPin);
  } catch (err) {
    console.error("PIN reset failed:", err.message);
    process.exit(1);
  } finally {
    process.exit(0);
  }
}

main();