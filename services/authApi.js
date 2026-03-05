// services/authApi.js
import { httpsCallable } from "firebase/functions";
import { signInWithCustomToken } from "firebase/auth";
import { auth, functions } from "../firebaseConfig";

/**
 * Cloud Function callables (Gen2, europe-west2)
 */
const fnAuthSignUp = httpsCallable(functions, "authSignUp");
const fnAuthSignInWithPin = httpsCallable(functions, "authSignInWithPin");
const fnAuthRequestMagicLink = httpsCallable(functions, "authRequestMagicLink");
const fnAuthConsumeMagicLink = httpsCallable(functions, "authConsumeMagicLink");

/**
 * Sign up: username + pin (+ optional email)
 * Returns: { uid }
 * Also signs the user into Firebase Auth (custom token)
 */
export async function signUpWithPin({ username, pin, email }) {
  const res = await fnAuthSignUp({
    username,
    pin,
    email: email || null,
  });

  const token = res?.data?.token;
  const uid = res?.data?.uid;

  if (!token) throw new Error("No token returned from authSignUp");

  await signInWithCustomToken(auth, token);
  return { uid };
}

/**
 * Login: username + pin
 * Returns: { uid }
 * Also signs the user into Firebase Auth (custom token)
 */
export async function loginWithPin({ username, pin }) {
  const res = await fnAuthSignInWithPin({ username, pin });

  const token = res?.data?.token;
  const uid = res?.data?.uid;

  if (!token) throw new Error("No token returned from authSignInWithPin");

  await signInWithCustomToken(auth, token);
  return { uid };
}

/**
 * Request magic link by username.
 * Server will only send if that username exists AND user has an email saved.
 * Returns: { ok: true } always (for privacy)
 */
export async function requestMagicLink({ username }) {
  const res = await fnAuthRequestMagicLink({ username });
  return { ok: !!res?.data?.ok };
}

/**
 * Consume magic link (called from the web landing handler).
 * Inputs are the query params:
 *  - usernameKey (u)
 *  - token (t)
 *
 * Returns: { uid }
 * Also signs the user into Firebase Auth (custom token)
 */
export async function consumeMagicLink({ usernameKey, token }) {
  const res = await fnAuthConsumeMagicLink({ usernameKey, token });

  const firebaseToken = res?.data?.token;
  const uid = res?.data?.uid;

  if (!firebaseToken) throw new Error("No token returned from authConsumeMagicLink");

  await signInWithCustomToken(auth, firebaseToken);
  return { uid };
}

/**
 * Web-only helper:
 * If the URL contains ?u=...&t=..., consume the magic link automatically.
 *
 * Returns:
 *  - { consumed: true, uid } if it signed in
 *  - { consumed: false } if no params found or not running on web
 */
export async function consumeMagicLinkFromUrlIfPresent() {
  if (typeof window === "undefined") return { consumed: false };

  const params = new URLSearchParams(window.location.search);
  const usernameKey = params.get("u");
  const token = params.get("t");

  if (!usernameKey || !token) return { consumed: false };

  const { uid } = await consumeMagicLink({ usernameKey, token });
  return { consumed: true, uid };
}