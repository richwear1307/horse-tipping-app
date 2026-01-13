import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyAvWOfmCS8qJh9IwEgawM5oqImCV4k9aho",
  authDomain: "horse-tipping-app.firebaseapp.com",
  projectId: "horse-tipping-app",
  storageBucket: "horse-tipping-app.firebasestorage.app",
  messagingSenderId: "97409052746",
  appId: "1:97409052746:web:6e22fdb61d047d1198b6b3",
};

const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const db = getFirestore(app);
