import { StatusBar } from "expo-status-bar";
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  StyleSheet,
  Text,
  View,
  Pressable,
  FlatList,
  Alert,
  Platform,
  TextInput,
  ScrollView,
  useWindowDimensions,
  ImageBackground,
  Animated,
  Switch,
  Image,
} from "react-native";

import {
  signUpWithPin,
  loginWithPin,
  requestMagicLink,
  consumeMagicLinkFromUrlIfPresent,
} from "./services/authApi";

import { getFunctions, httpsCallable } from "firebase/functions";

import {
  House,
  Save,
  Lightbulb,
  Trophy,
  ListChecks,
  UserRoundPen,
  Flame,
} from "lucide-react-native";

import { Picker } from "@react-native-picker/picker";

import { auth, db as firestoreDb } from "./firebaseConfig";
import {
  onAuthStateChanged,
  signOut,
} from "firebase/auth";

import {
  addDoc,
  collection,
  onSnapshot,
  orderBy,
  query,
  where,
  doc,
  limit,
  setDoc,
  deleteDoc,
  getDocs,
  arrayUnion,
  arrayRemove,
  serverTimestamp,
} from "firebase/firestore";

// ---- GA4 helper (web only) ----
function gaEvent(name, params = {}) {
  if (Platform.OS !== "web") return;

  // gtag is created by the GA script in public/index.html
  if (typeof window !== "undefined" && typeof window.gtag === "function") {
    window.gtag("event", name, params);
  } else {
    // Optional: helps you debug if GA isn't loaded on live
    console.log("[GA missing] event:", name, params);
  }
}

function gaScreen(screenName, params = {}) {
  if (Platform.OS !== "web") return;

  if (typeof window !== "undefined" && typeof window.gtag === "function") {
    // GA4 "screen_view" works well for SPA-style apps
    window.gtag("event", "screen_view", {
      screen_name: screenName,
      ...params,
    });
  }
}

// ---- GA4 "screens" for web SPA: send virtual page_view ----
function trackScreen(screenKey, screenLabel) {
  if (Platform.OS !== "web") return;
  if (typeof window === "undefined" || typeof window.gtag !== "function") return;

  const path = `/${String(screenKey || "home").toLowerCase()}`;

  window.gtag("event", "page_view", {
    page_title: screenLabel,
    page_path: path,
    page_location: `${window.location.origin}${path}`,
  });

  // Optional: keep screen_view too (shows in Events/DebugView)
  window.gtag("event", "screen_view", {
    screen_name: screenLabel,
    app_name: "Horse Tipping App",
  });
}

function showMessage(title, message) {
  if (Platform.OS === "web") alert(`${title}\n\n${message}`);
  else Alert.alert(title, message);
}

function ProfileCornerButton({ onPress }) {
  const { width } = useWindowDimensions();

  // Must match your styles.content maxWidth and paddingHorizontal
  const CONTENT_MAX_WIDTH = 520;
  const CONTENT_PADDING_X = 16;

  // Align to the right edge of the centered content column
  const sideGutter = Math.max((width - CONTENT_MAX_WIDTH) / 2, 0);
  const rightOffset = sideGutter + CONTENT_PADDING_X;

  return (
    <Pressable
      onPress={onPress}
      style={[styles.profileCornerButton, { right: rightOffset }]}
      hitSlop={10}
    >
      <UserRoundPen size={22} color={THEME.text} strokeWidth={2} />
    </Pressable>
  );
}

function TopBar({ onLogout, onProfile, onAdmin }) {
  return (
    <View style={styles.topBar}>
      <View style={styles.topBarInner}>
        {/* LEFT */}
        <Pressable onPress={onLogout} style={styles.topBarBtn} hitSlop={10}>
          <Text style={styles.topBarBtnText}>Log out</Text>
        </Pressable>

        {/* CENTER (ADMIN ONLY) */}
        {onAdmin ? (
          <Pressable
            onPress={onAdmin}
            style={[styles.topBarBtn, styles.topBarAdminBtn]}
            hitSlop={10}
          >
            <Text style={styles.topBarAdminText}>ADMIN</Text>
          </Pressable>
        ) : (
          <View style={{ width: 60 }} /> // spacer keeps centering
        )}

        {/* RIGHT */}
        <Pressable
          onPress={onProfile}
          style={[styles.topBarBtn, { flexDirection: "row", alignItems: "center", gap: 6 }]}
          hitSlop={10}
        >
          <Text style={styles.topBarBtnText}>Profile</Text>
          <UserRoundPen size={18} color={THEME.text} strokeWidth={2} />
        </Pressable>
      </View>
    </View>
  );
}

const FOOTER_HEIGHT = 78;
const HERO_IMAGE = require("./assets/hero.jpg");

function FooterBar({ active, onGoHome, onGoRaces, onGoMyTips, onGoLeaderboard, onGoResults }) {
const Item = ({ keyName, label, Icon, onPress }) => {
  const isActive = active === keyName;

  const color = isActive ? THEME.primary : THEME.text3;
  const size = isActive ? 24 : 22;
  const strokeWidth = isActive ? 2.5 : 1.8;

  return (
    <Pressable
      onPress={onPress}
      style={[styles.footerBtn, isActive && styles.footerBtnActive]}
      hitSlop={10}
    >
      <Icon size={size} color={color} strokeWidth={strokeWidth} />

      <Text
        style={[styles.footerText, isActive && styles.footerTextActive]}
        numberOfLines={1}
        ellipsizeMode="tail"
        adjustsFontSizeToFit
        minimumFontScale={0.85}
      >
        {label}
      </Text>
    </Pressable>
  );
};

  return (
    <View style={styles.footerBar}>
      <View style={styles.footerInner}>
<Item keyName="home" label="Home" Icon={House} onPress={onGoHome} />
<Item keyName="races" label="Enter Tips" Icon={Lightbulb} onPress={onGoRaces} />
<Item keyName="myTips" label="My Tips" Icon={Save} onPress={onGoMyTips} />
<Item
  keyName="leaderboard"
  label="Leaderboard"
  Icon={Trophy}
  onPress={onGoLeaderboard}
/>
<Item keyName="results" label="Results" Icon={ListChecks} onPress={onGoResults} />
      </View>
    </View>
  );
}

// GBP scoring defaults
const STAKE_GBP = 5;              // £5 per tip
const DEFAULT_PLACES_PAID = 3;     // top 3 count as "placed"
const DEFAULT_EW_FRACTION = 0.25;  // 1/4 odds
function formatCountdownHM(ms) {
  if (ms <= 0) return "Locked 🔒";

  const totalMinutes = Math.floor(ms / 60000);

  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  return `${hours}h ${minutes}m`;
}

function formatDateShortUK(dayStr) {
  const s = String(dayStr ?? "").trim();

  // accept YYYY-MM-DD
  let y, m, d;
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) {
    y = Number(iso[1]);
    m = Number(iso[2]) - 1;
    d = Number(iso[3]);
  } else {
    // accept DD/MM/YYYY
    const uk = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (!uk) return s;
    d = Number(uk[1]);
    m = Number(uk[2]) - 1;
    y = Number(uk[3]);
  }

  // Use UTC to avoid parsing quirks, display in UK timezone
  const dt = new Date(Date.UTC(y, m, d));

  return dt.toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "Europe/London",
  });
}

function formatDateDDMMYYYY(value) {
  const s = String(value ?? "").trim();

  // YYYY-MM-DD  -> DD-MM-YYYY
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;

  // DD/MM/YYYY -> DD-MM-YYYY
  const m2 = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (m2) return `${m2[1]}-${m2[2]}-${m2[3]}`;

  return s;
}
function fractionalToDecimal(input) {
  // Accepts: "5/1", "11/4", "7/2", "3", "3.5"
  const s = String(input ?? "").trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);

  const m = s.match(/^(\d+)\s*\/\s*(\d+)$/);
  if (!m) return null;

  const num = Number(m[1]);
  const den = Number(m[2]);
  if (!den) return null;

  return 1 + num / den;
}

function fractionToNumber(input) {
  // For fractions like "1/4" -> 0.25
  const s = String(input ?? "").trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);

  const m = s.match(/^(\d+)\s*\/\s*(\d+)$/);
  if (!m) return null;

  const num = Number(m[1]);
  const den = Number(m[2]);
  if (!den) return null;

  return num / den;
}

function formatGBP(value) {
  const n = Number(value) || 0;
  return `£${n.toFixed(2)}`;
}

const DAY_SWITCH_HOUR = 18; // 6pm UK time

function toISODateUK(value) {
  if (!value) return "";

  if (typeof value === "string") {
    const s = value.trim();

    // already YYYY-MM-DD
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

    // convert DD/MM/YYYY -> YYYY-MM-DD
    const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (m) return `${m[3]}-${m[2]}-${m[1]}`;

    return "";
  }

  // Firestore Timestamp
  if (typeof value?.toMillis === "function") {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/London",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(value.toMillis()));
  }

  if (value instanceof Date) {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/London",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(value);
  }

  return "";
}

const isISODate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s.trim());

function getRaceDays(races) {
  const days = [...new Set((races ?? []).map((r) => String(r?.date ?? "").trim()))];
  return days.filter(isISODate).sort();
}

function formatDayLabel(dayStr) {
  const s = String(dayStr ?? "").trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return s;

  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const da = Number(m[3]);

  // Use UTC to avoid platform parsing quirks
  const d = new Date(Date.UTC(y, mo, da));

  return d.toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "Europe/London",
  });
}

function formatOffTimeUK(offTime) {
  // Returns "HH:MM" or "" if unknown
  if (!offTime) return "";

  // Firestore Timestamp
  if (typeof offTime?.toMillis === "function") {
    const dt = new Date(offTime.toMillis());
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/London",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(dt);
  }

  // JS Date
  if (offTime instanceof Date) {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/London",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(offTime);
  }

  // If it's already a string like "13:20"
  if (typeof offTime === "string") return offTime.trim();

  return "";
}

function getActiveRaceDay(races) {
  if (!races || races.length === 0) return null;

  const days = getRaceDays(races);
  const now = new Date();
  const today = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/London",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(now);
  const hour = now.getHours();

  let index = days.indexOf(today);

  if (index === -1) {
    if (today < days[0]) return days[0];
    if (today > days[days.length - 1]) return days[days.length - 1];
  }

  if (hour >= DAY_SWITCH_HOUR && index < days.length - 1) {
    return days[index + 1];
  }

  return days[index] ?? days[0];
}

function getWinnerHorse(raceResult) {
  // Backwards compatible: supports old { winnerHorse } shape too
  if (!raceResult) return null;
  if (typeof raceResult === "string") return raceResult;
  if (raceResult.winnerHorse) return raceResult.winnerHorse;
  const p1 = raceResult.placements?.find((p) => p.position === 1);
  return p1?.horseName ?? null;
}

function calcGbpProfitForTip(tip, raceResult, stake = STAKE_GBP) {
  if (!raceResult) return 0;

  // Backwards compatible (old winner-only results)
  if (typeof raceResult === "string") {
    return raceResult === tip.horseName ? stake : 0;
  }

  const placesPaid = raceResult.placesPaid ?? DEFAULT_PLACES_PAID;
  const eachWayFraction = raceResult.eachWayFraction ?? DEFAULT_EW_FRACTION;

  const tipHorseId = String(tip.horseId ?? "").trim();

let entry =
  tipHorseId
    ? raceResult.placements?.find((p) => String(p.horseId ?? "").trim() === tipHorseId)
    : null;

// fallback for old tips/results
if (!entry) {
  entry = raceResult.placements?.find((p) => p.horseName === tip.horseName);
}
  if (!entry) return 0;

  const odds = Number(entry.oddsDecimal);
  if (!odds || odds <= 1) return 0;

  const winProfit = stake * (odds - 1);

  if (entry.position === 1) {
  const placeProfit = winProfit * eachWayFraction;
  return winProfit + placeProfit;
}

  if (entry.position > 1 && entry.position <= placesPaid) {
    return winProfit * eachWayFraction;
  }

  return 0;
}

export default function App() {
  const [user, setUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);

useEffect(() => {
  // Web: if URL has ?u=...&t=..., consume it and sign in.
  consumeMagicLinkFromUrlIfPresent()
    .then(({ consumed }) => {
      if (consumed && typeof window !== "undefined") {
        // optional: clean the URL after successful sign-in
        window.history.replaceState({}, document.title, window.location.origin);
      }
    })
    .catch((e) => {
      console.log("consumeMagicLinkFromUrlIfPresent failed:", e?.message || e);
      // optional: showMessage("Sign-in link failed", "That link may have expired. Request a new one.");
    });
}, []);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setAuthLoading(false);
    });
    return unsub;
  }, []);

  if (authLoading) {
    return (
      <View style={styles.container}>
        <Text style={styles.subtitle}>Loading…</Text>
      </View>
    );
  }

  if (!user) {
    return <AuthScreen />;
  }

  return <GameApp user={user} />;
}


function GameApp({ user }) {
  // ✅ Game hooks ALWAYS run within GameApp
  const [screen, setScreen] = useState("home"); // home | races | raceDetails | myTips | adminSelectCompetition | adminEnterResults | leaderboard | profile | results
  const SCREEN_LABELS = {
  home: "Home",
  races: "Races",
  raceDetails: "Race Details",
  myTips: "My Tips",
  leaderboard: "Leaderboard",
  results: "Results",
  profile: "Profile",
  rules: "Rules",

  // Admin screens
  adminSelectCompetition: "Admin – Select Competition",
  adminCompetitionHome: "Admin – Competition Home",
  adminEnterResults: "Admin – Enter Results",
  adminEntrants: "Admin – Manage Entrants",
};
  const [selectedRaceId, setSelectedRaceId] = useState(null);
  const [prefillHorse, setPrefillHorse] = useState(null);
  const [tips, setTips] = useState([]);
  const [tipsLoading, setTipsLoading] = useState(true);
  const [allTips, setAllTips] = useState([]); // ✅ NEW: all users' tips for home leaderboard summary
  const [results, setResults] = useState({}); // local results for now
const [races, setRaces] = useState([]);
const [racesLoading, setRacesLoading] = useState(true);
const [horsesById, setHorsesById] = useState({});
const [myProfile, setMyProfile] = useState(null); // ✅ NEW: current user's profile doc
const [usersMap, setUsersMap] = useState({});     // (keep this for admin screens like entrants)
const isAdmin = !!myProfile?.isAdmin;             // ✅ admin comes from your own doc
const missingDisplayName = !myProfile?.displayName?.trim();

  // Competitions (Option B: one active competition for everyone)
  const [competitions, setCompetitions] = useState([]);
  const [activeCompetitionId, setActiveCompetitionId] = useState(null);
  
  const [nowTick, setNowTick] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), 60000); // re-evaluate daily lock each minute
    return () => clearInterval(id);
  }, []);

    // ✅ Calendar day (UK) - used ONLY for the Home "Today" box
  const calendarDay = useMemo(() => {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/London",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
  }, [nowTick]);

useEffect(() => {
  const label = SCREEN_LABELS[screen] ?? screen;
  trackScreen(screen, label);
}, [screen]);

useEffect(() => {
  // ✅ No active competition -> no races
  if (!activeCompetitionId) {
    setRaces([]);
    setRacesLoading(false);
    return;
  }

  setRacesLoading(true);

  const q = query(
    collection(firestoreDb, "races"),
    where("competitionId", "==", activeCompetitionId),
    orderBy("date", "asc"),
    orderBy("order", "asc")
  );

  const unsub = onSnapshot(
    q,
    (snap) => {
      const list = snap.docs.map((d) => {
        const data = d.data();
        const date = toISODateUK(data.date);
        const offTime = formatOffTimeUK(data.offTime);
        const offTimeText = formatOffTimeUK(data.offTime);

        // 1) If race already has explicit runners array, keep using it (backwards compatible)
const rawRunners = Array.isArray(data.runners) ? data.runners : [];
const runnersFromRunnersField = rawRunners
  .map((r) => ({
    // ✅ REQUIRED for settlement mapping
    horseId: String(r.horseId ?? r.horseID ?? r.id ?? "").trim() || null,

    number: Number(r.number ?? r.horseNumber ?? r.no ?? 0),
    horseName: String(r.horseName ?? r.name ?? r.horse ?? "").trim(),
    oddsDisplay: String(r.oddsDisplay ?? r.odds ?? "").trim(),
    oddsDecimal: Number(r.oddsDecimal ?? r.decimalOdds ?? 0),

    jockey: String(r.jockey ?? r.jockeyName ?? "").trim(),
    trainer: String(r.trainer ?? r.trainerName ?? "").trim(),
  }))
  // ✅ keep only runners with BOTH a name and horseId
  .filter((r) => r.horseName);

// 2) Otherwise hydrate from horseIds -> horsesById lookup
const horseIds = Array.isArray(data.horseIds) ? data.horseIds : [];
const runnersFromHorseIds = horseIds
  .map((hid, index) => {
    const h = horsesById?.[hid];
    if (!h) return null;

return {
  horseId: hid, // ✅ ADD THIS (key used by Cloud Function)
  number: Number(h.number ?? index + 1),
  horseName: String(h.name ?? "").trim(),
  oddsDisplay: String(h.odds ?? h.oddsDisplay ?? "").trim(),
  oddsDecimal: Number(h.oddsDecimal ?? 0),

  jockey: String(h.jockey ?? h.jockeyName ?? "").trim(),
  trainer: String(h.trainer ?? h.trainerName ?? "").trim(),
};
  })
  .filter(Boolean);

// 3) Choose runners source: prefer explicit data.runners; else use horseIds hydration
const runners = runnersFromRunnersField.length
  ? runnersFromRunnersField
  : runnersFromHorseIds;

// 4) Horses list (names) for UI compatibility
const horses =
  Array.isArray(data.horses) && data.horses.length
    ? data.horses
    : runners.map((r) => r.horseName);

        const lockAt =
          typeof data.lockAt === "number"
            ? data.lockAt
            : data.lockAt?.toMillis?.() ?? 0;

        return {
          id: d.id,
          ...data,
          date,
          offTime,
          offTimeText,
          runners,
          horses,
          lockAt,
        };
      });

      setRaces(list);
      setRacesLoading(false);
    },
    (err) => {
      setRacesLoading(false);
      showMessage("Races load error", err.message);
    }
  );

  return unsub;
}, [activeCompetitionId, horsesById]);

  // Settings: active competition id
  useEffect(() => {
    const ref = doc(firestoreDb, "settings", "app");
    return onSnapshot(
      ref,
      (snap) => {
        const data = snap.data() || {};
        setActiveCompetitionId(data.activeCompetitionId ?? null);
      },
      (err) => showMessage("Settings load error", err.message)
    );
  }, []);

useEffect(() => {
  // Guard: don't start a listener without a valid competition id
  if (!activeCompetitionId) {
    setHorsesById({});
    return;
  }

  const q = collection(
    firestoreDb,
    "competitions",
    activeCompetitionId,
    "horses"
  );

  const unsubscribe = onSnapshot(
    q,
    (snap) => {
      const map = {};
      snap.forEach((docSnap) => {
        map[docSnap.id] = { id: docSnap.id, ...docSnap.data() };
      });
      setHorsesById(map);
    },
    (err) => {
      console.log("[horses] snapshot error:", err.code, err.message);
      showMessage("Horses load error", err.message);
    }
  );

  return unsubscribe;
}, [activeCompetitionId]);


  // Competitions list
  useEffect(() => {
    const q = query(
      collection(firestoreDb, "competitions"),
      orderBy("createdAt", "desc")
    );

    return onSnapshot(
      q,
      (snap) => {
        const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        setCompetitions(list);
      },
      (err) => showMessage("Competitions load error", err.message)
    );
  }, []);


  // Derived competition values
  const activeCompetition = useMemo(() => {
    return competitions.find((c) => c.id === activeCompetitionId) ?? null;
  }, [competitions, activeCompetitionId]);

  const competitionDays = Array.isArray(activeCompetition?.days)
    ? activeCompetition.days
    : [];

const visibleRaces = useMemo(() => races ?? [], [races]);

  const activeDay = useMemo(
    () => getActiveRaceDay(visibleRaces),
    [visibleRaces, nowTick]
  );

const registeredUserIds = useMemo(() => {
  if (!activeCompetitionId) return [];

  return Object.entries(usersMap ?? {})
    .filter(([uid, u]) => {
      const arr = Array.isArray(u?.registeredCompetitionIds)
        ? u.registeredCompetitionIds
        : [];
      return arr.includes(activeCompetitionId);
    })
    .map(([uid]) => uid);
}, [usersMap, activeCompetitionId]);

useEffect(() => {
  if (!isAdmin) return;

  const unsub = onSnapshot(
    collection(firestoreDb, "users"),
    (snapshot) => {
      const map = {};
      snapshot.docs.forEach((d) => {
        map[d.id] = d.data();
      });
      setUsersMap(map);
    },
    (err) => showMessage("Users load error", err.message)
  );

  return unsub;
}, [isAdmin]);

useEffect(() => {
  if (!user) return;

const q = query(
  collection(firestoreDb, "tips"),
  where("userId", "==", user.uid)
);

  const unsubscribe = onSnapshot(q, (snapshot) => {
    const list = snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));
    setTips(list);
    setTipsLoading(false);
  });

  return unsubscribe;
}, [user]);

// ✅ NEW: Global tips feed (all users) for Home screen rank + winnings
useEffect(() => {
  const unsub = onSnapshot(
    collection(firestoreDb, "tips"),
    (snapshot) => {
      const list = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
      setAllTips(list);
    },
    (err) => showMessage("Tips load error", err.message)
  );

  return unsub;
}, []);

useEffect(() => {
  const unsubscribe = onSnapshot(
    collection(firestoreDb, "results"),
    (snapshot) => {
      const map = {};
      snapshot.docs.forEach((docSnap) => {
        map[docSnap.id] = docSnap.data(); // full result doc (placements, odds, etc.)
      });
      setResults(map);
    },
    (err) => showMessage("Results error", err.message)
  );

  return unsubscribe;
}, []);

useEffect(() => {
  if (!user) return;

  const ref = doc(firestoreDb, "users", user.uid);

  const unsubscribe = onSnapshot(
    ref,
    async (snap) => {
      // If profile doc exists, store it for admin checks + profile UI
      if (snap.exists()) {
        setMyProfile(snap.data());
        return;
      }

      // If profile doc doesn't exist, create it
      try {
        await setDoc(
          ref,
          {
            displayName: "",
            email: user.email ?? "",
            registeredCompetitionIds: [],
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
            isAdmin: false, // default
          },
          { merge: true }
        );
      } catch (e) {
        showMessage("Profile create failed", e.message);
      }
    },
    (err) => showMessage("Profile read failed", err.message)
  );

  return unsubscribe;
}, [user]);

useEffect(() => {
  if (!visibleRaces || visibleRaces.length === 0) return;

  const exists =
    selectedRaceId && visibleRaces.some((r) => r.id === selectedRaceId);
  if (exists) return;

  // Prefer first race for active day, else first race overall
  const firstForDay =
    (activeDay ? visibleRaces.find((r) => r.date === activeDay) : null) ??
    visibleRaces[0];

  if (firstForDay?.id) setSelectedRaceId(firstForDay.id);
}, [visibleRaces, activeDay, selectedRaceId]);

  const selectedRace = visibleRaces.find((r) => r.id === selectedRaceId) || null;

  // Used to highlight the correct tab in the footer
  const activeTab = screen === "raceDetails" ? "races" : screen;

const gbpTotal = useMemo(() => {
  let total = 0;
  for (const tip of tips) {
    total += calcGbpProfitForTip(tip, results[tip.raceId], STAKE_GBP);
  }
  return total;
}, [tips, results]);

  // ✅ NEW: Home screen leaderboard position + winnings (Today vs Cumulative)
  const homeLeaderboard = useMemo(() => {
    const racesById = Object.fromEntries((visibleRaces ?? []).map((r) => [r.id, r]));

    // Only count tips for races that have results (i.e., completed/settled)
    const completedTips = (allTips ?? []).filter((t) => !!results?.[t.raceId]);

    const buildRows = (scope) => {
      const byUser = {}; // userId -> { userId, gbp }

      const scoped =
        scope === "all"
          ? completedTips
          : completedTips.filter((t) => {
              const race = racesById[t.raceId];
              return race && race.date === calendarDay;
            });

      for (const t of scoped) {
        const userId = t.userId || "unknown";
        if (!byUser[userId]) byUser[userId] = { userId, gbp: 0 };

        byUser[userId].gbp += calcGbpProfitForTip(
          t,
          results?.[t.raceId],
          STAKE_GBP
        );
      }

      return Object.values(byUser).sort((a, b) => b.gbp - a.gbp);
    };

    const dayRows = buildRows("day");
    const allRows = buildRows("all");

    const dayIndex = dayRows.findIndex((r) => r.userId === user.uid);
    const allIndex = allRows.findIndex((r) => r.userId === user.uid);

    return {
      dayRank: dayIndex >= 0 ? dayIndex + 1 : null,
      dayTotalUsers: dayRows.length,
      dayWinnings: dayIndex >= 0 ? dayRows[dayIndex].gbp : 0,

      allRank: allIndex >= 0 ? allIndex + 1 : null,
      allTotalUsers: allRows.length,
      allWinnings: allIndex >= 0 ? allRows[allIndex].gbp : 0,
    };
  }, [allTips, results, visibleRaces, calendarDay, user.uid]);

if (screen === "results") {
  return (
    <View style={{ flex: 1, paddingBottom: FOOTER_HEIGHT }}>
<TopBar
  onLogout={() => signOut(auth)}
  onProfile={() => setScreen("profile")}
  onAdmin={isAdmin ? () => setScreen("adminSelectCompetition") : null}
/>
 <ResultsScreen
        races={visibleRaces}
  results={results}
  allTips={allTips}
  activeDay={activeDay}
  onBack={() => setScreen("home")}
/>
      <FooterBar
        active={activeTab}
        onGoHome={() => setScreen("home")}
        onGoRaces={() => setScreen("races")}
        onGoMyTips={() => setScreen("myTips")}
        onGoLeaderboard={() => setScreen("leaderboard")}
        onGoResults={() => setScreen("results")}
      />
    </View>
  );
}

if (screen === "rules") {
  return (
    <View style={{ flex: 1, paddingBottom: FOOTER_HEIGHT }}>
      <TopBar
        onLogout={() => signOut(auth)}
        onProfile={() => setScreen("profile")}
        onAdmin={isAdmin ? () => setScreen("adminSelectCompetition") : null}
      />

      <RulesScreen onBack={() => setScreen("home")} />

      <FooterBar
        active={activeTab}
        onGoHome={() => setScreen("home")}
        onGoRaces={() => setScreen("races")}
        onGoMyTips={() => setScreen("myTips")}
        onGoLeaderboard={() => setScreen("leaderboard")}
        onGoResults={() => setScreen("results")}
      />
    </View>
  );
}

if (screen === "profile") {
  return (
    <View style={{ flex: 1, paddingBottom: FOOTER_HEIGHT }}>
<TopBar
  onLogout={() => signOut(auth)}
  onProfile={() => setScreen("profile")}
  onAdmin={isAdmin ? () => setScreen("adminSelectCompetition") : null}
/>
      <ProfileScreen user={user} onBack={() => setScreen("home")} />
      <FooterBar
        active={activeTab}
        onGoHome={() => setScreen("home")}
        onGoRaces={() => setScreen("races")}
        onGoMyTips={() => setScreen("myTips")}
        onGoLeaderboard={() => setScreen("leaderboard")}
        onGoResults={() => setScreen("results")}
      />
    </View>
  );
}

if (screen === "races") {
  return (
    <View style={{ flex: 1, paddingBottom: FOOTER_HEIGHT }}>
<TopBar
  onLogout={() => signOut(auth)}
  onProfile={() => setScreen("profile")}
  onAdmin={isAdmin ? () => setScreen("adminSelectCompetition") : null}
/>
      <RacesScreen
        races={visibleRaces}
        racesLoading={racesLoading}
        activeDay={activeDay}
        tips={tips}
        allTips={allTips}
        onBack={() => setScreen("home")}
onPickTip={async (raceId, horseName, wasSelected) => {
  try {
    const race = visibleRaces.find((r) => r.id === raceId);
    if (!race) return;

    setSelectedRaceId(raceId);

    const now = Date.now();
    const lockAt = race.lockAt ?? 0;

    // Block changes after lock
    if (lockAt && now >= lockAt) {
      showMessage(
        "Tips closed 🔒",
        "This race is locked. You can’t submit, change, or remove your tip now."
      );
      return;
    }

    const tipId = `${user.uid}_${raceId}`;
    const tipRef = doc(firestoreDb, "tips", tipId);

    // If they tapped the already-selected horse, remove the tip
    if (wasSelected) {
      await deleteDoc(tipRef);
      gaEvent("tip_removed", {
        competition_id: activeCompetitionId ?? "none",
        race_id: raceId,
        race_name: race.name ?? "",
        horse_name: horseName ?? "",
      });
      showMessage("Tip removed ✅", `Race: ${race.name}`);
      return;
    }

    // ✅ NEW: derive horseId + odds from the selected runner
    const runner =
  (race.runners ?? []).find((r) => r.horseName === horseName) ?? null;

const horseId = String(runner?.horseId ?? "").trim();
const odds = String(runner?.oddsDisplay ?? "").trim();

if (!horseId) {
  showMessage(
    "Horse ID missing",
    "This runner is missing a horseId, so it can’t be settled. Please ask admin to fix the race runners."
  );
  return;
}

await setDoc(
  tipRef,
  {
    userId: user.uid,
    userEmail: user.email ?? "",
    raceId,
    raceName: race.name,
    date: race.date,

    // ✅ REQUIRED by settleRaceOnResult
    horseId,
    odds,

    // UI only
    horseName,

    lockAt,
    updatedAt: now,
    createdAt: now,
  },
  { merge: true }
);


    showMessage("Tip saved ✅", `Race: ${race.name}\nTip: ${horseName}`);
  } catch (e) {
    showMessage("Error saving tip", e.message);
  }
}}

      />
      <FooterBar
        active={activeTab}
        onGoHome={() => setScreen("home")}
        onGoRaces={() => setScreen("races")}
        onGoMyTips={() => setScreen("myTips")}
        onGoLeaderboard={() => setScreen("leaderboard")}
        onGoResults={() => setScreen("results")}
      />
    </View>
  );
}

if (screen === "raceDetails" && selectedRace) {
  return (
    <View style={{ flex: 1, paddingBottom: FOOTER_HEIGHT }}>
<TopBar
  onLogout={() => signOut(auth)}
  onProfile={() => setScreen("profile")}
  onAdmin={isAdmin ? () => setScreen("adminSelectCompetition") : null}
/>
 <RaceDetailsScreen
  race={selectedRace}
  onSubmitTip={async (horseName) => {
    try {
      const race = selectedRace;
      if (!race) return;

      const now = Date.now();
      const lockAt = race.lockAt ?? 0;

      if (lockAt && now >= lockAt) {
        showMessage("Tips closed 🔒", "This race is locked.");
        return;
      }

      const tipId = `${user.uid}_${race.id}`;
      const tipRef = doc(firestoreDb, "tips", tipId);

      // ✅ NEW: derive horseId + odds from runners
      const runner =
        (race.runners ?? []).find((r) => r.horseName === horseName) ?? null;

      const horseId = String(runner?.horseId ?? "").trim();
if (!horseId) {
  showMessage(
    "Horse ID missing",
    "This runner is missing a horseId, so it can’t be settled. Please ask admin to fix the race runners."
  );
  return;
}
      const odds = runner?.oddsDisplay ?? "";

      await setDoc(
        tipRef,
        {
          userId: user.uid,
          userEmail: user.email ?? "",
          raceId: race.id,
          raceName: race.name,
          date: race.date,

          // ✅ REQUIRED by settleRaceOnResult
          horseId,
          odds,

          // keep for UI
          horseName,

          lockAt,
          updatedAt: now,
          createdAt: now,
        },
        { merge: true }
      );

      showMessage("Tip saved ✅", `Race: ${race.name}`);
    } catch (e) {
      showMessage("Error saving tip", e.message);
    }
  }}
/>

      <FooterBar
        active={activeTab}
        onGoHome={() => setScreen("home")}
        onGoRaces={() => setScreen("races")}
        onGoMyTips={() => setScreen("myTips")}
        onGoLeaderboard={() => setScreen("leaderboard")}
        onGoResults={() => setScreen("results")}
      />
    </View>
  );
}

if (screen === "myTips") {
  return (
    <View style={{ flex: 1, paddingBottom: FOOTER_HEIGHT }}>
<TopBar
  onLogout={() => signOut(auth)}
  onProfile={() => setScreen("profile")}
  onAdmin={isAdmin ? () => setScreen("adminSelectCompetition") : null}
/>
            <MyTipsScreen
              currentUserId={user.uid}
              tips={tips}
              tipsLoading={tipsLoading}
              results={results}
  races={visibleRaces}
  activeDay={activeDay}
  allTips={allTips}
  usersMap={usersMap}
  nowTick={nowTick}
  activeCompetitionId={activeCompetitionId}
  onBack={() => setScreen("home")}
  onClear={() => { /* optional */ }}
  onAmendTips={() => setScreen("races")}
/>
<FooterBar
        active={activeTab}
        onGoHome={() => setScreen("home")}
        onGoRaces={() => setScreen("races")}
        onGoMyTips={() => setScreen("myTips")}
        onGoLeaderboard={() => setScreen("leaderboard")}
        onGoResults={() => setScreen("results")}
      />
    </View>
  );
}
function AdminSelectCompetitionScreen({
  competitions,
  activeCompetitionId,
  onSetActiveCompetition,
  onManageCompetition,
}) {
  const [error, setError] = useState("");

  const activeCompetition =
    competitions?.find((c) => c.id === activeCompetitionId) ?? null;

  const toggle = async (competitionId) => {
    setError("");

    // Turning OFF the active competition
    if (activeCompetitionId === competitionId) {
      await onSetActiveCompetition?.(null);
      return;
    }

    // Turning ON a different competition while one is already active
    if (activeCompetitionId && activeCompetitionId !== competitionId) {
      const msg =
        "Only one competition can be active. Please deactivate the current active competition before activating another.";
      setError(msg);
      showMessage("Action needed", msg);
      return;
    }

    // Turning ON (none active yet)
    await onSetActiveCompetition?.(competitionId);
  };

  return (
    <View style={styles.container}>
      <View style={styles.content}>
        <Text style={styles.title}>Select competition</Text>
        <Text style={styles.subtitle}>
          Toggle a competition active. Only one can be active at a time.
        </Text>

        {!!error && <Text style={styles.adminError}>{error}</Text>}

        <View style={[styles.card, { marginTop: 8 }]}>
          {competitions?.length ? (
            competitions.map((c) => {
              const isActive = c.id === activeCompetitionId;
              return (
                <View key={c.id} style={styles.adminCompRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.rowTitle}>
                      {c.name || "Untitled competition"}
                    </Text>
                    <Text style={styles.rowSub}>
                      {isActive ? "Active" : "Inactive"}
                    </Text>
                  </View>

                  <Switch value={isActive} onValueChange={() => toggle(c.id)} />
                </View>
              );
            })
          ) : (
            <Text style={styles.muted}>No competitions found.</Text>
          )}
        </View>

        {/* Show ONLY when one is active */}
        {activeCompetition ? (
          <Pressable
            style={[styles.button, styles.buttonPrimary, { marginTop: 12 }]}
            onPress={onManageCompetition}
          >
            <Text style={styles.buttonText}>Manage competition</Text>
          </Pressable>
        ) : (
          <View style={[styles.card, styles.cardAlt, { marginTop: 12 }]}>
            <Text style={styles.cardHint}>
              Activate a competition to manage results.
            </Text>
          </View>
        )}
      </View>
    </View>
  );
}
if (screen === "adminSelectCompetition") {
  return (
    <View style={{ flex: 1, paddingBottom: FOOTER_HEIGHT }}>
      <TopBar
        onLogout={() => signOut(auth)}
        onProfile={() => setScreen("profile")}
        onAdmin={isAdmin ? () => setScreen("adminSelectCompetition") : null}
      />

<AdminSelectCompetitionScreen
  competitions={competitions}
  activeCompetitionId={activeCompetitionId}
  onSetActiveCompetition={async (id) => {
    try {
      await setDoc(
        doc(firestoreDb, "settings", "app"),
        { activeCompetitionId: id === null ? null : id },
        { merge: true }
      );
    } catch (e) {
      showMessage("Error", e.message);
    }
  }}
  onManageCompetition={() => setScreen("adminCompetitionHome")}
/>

      <FooterBar
        active={activeTab}
        onGoHome={() => setScreen("home")}
        onGoRaces={() => setScreen("races")}
        onGoMyTips={() => setScreen("myTips")}
        onGoLeaderboard={() => setScreen("leaderboard")}
        onGoResults={() => setScreen("results")}
      />
    </View>
  );
}

if (screen === "adminCompetitionHome") {
  return (
    <View style={{ flex: 1, paddingBottom: FOOTER_HEIGHT }}>
      <TopBar
        onLogout={() => signOut(auth)}
        onProfile={() => setScreen("profile")}
        onAdmin={isAdmin ? () => setScreen("adminSelectCompetition") : null}
      />

      <AdminCompetitionHomeScreen
        competitions={competitions}
        activeCompetitionId={activeCompetitionId}
        onEnterResults={() => setScreen("adminEnterResults")}
        onManageEntrants={() => setScreen("adminEntrants")}
        onBack={() => setScreen("adminSelectCompetition")}
      />

      <FooterBar
        active={activeTab}
        onGoHome={() => setScreen("home")}
        onGoRaces={() => setScreen("races")}
        onGoMyTips={() => setScreen("myTips")}
        onGoLeaderboard={() => setScreen("leaderboard")}
        onGoResults={() => setScreen("results")}
      />
    </View>
  );
}

if (screen === "adminEntrants") {
  return (
    <View style={{ flex: 1, paddingBottom: FOOTER_HEIGHT }}>
      <TopBar
        onLogout={() => signOut(auth)}
        onProfile={() => setScreen("profile")}
        onAdmin={isAdmin ? () => setScreen("adminSelectCompetition") : null}
      />

      <AdminEntrantsScreen
        competitions={competitions}
        activeCompetitionId={activeCompetitionId}
        usersMap={usersMap}
        onBack={() => setScreen("adminCompetitionHome")}
      />

      <FooterBar
        active={activeTab}
        onGoHome={() => setScreen("home")}
        onGoRaces={() => setScreen("races")}
        onGoMyTips={() => setScreen("myTips")}
        onGoLeaderboard={() => setScreen("leaderboard")}
        onGoResults={() => setScreen("results")}
      />
    </View>
  );
}

if (screen === "adminEnterResults") {
  return (
    <View style={{ flex: 1, paddingBottom: FOOTER_HEIGHT }}>
      <TopBar
        onLogout={() => signOut(auth)}
        onProfile={() => setScreen("profile")}
        onAdmin={isAdmin ? () => setScreen("adminSelectCompetition") : null}
      />

      <AdminScreen
        races={visibleRaces}
        allRaces={races}
        results={results}
        onBack={() => setScreen("adminSelectCompetition")}
        competitions={competitions}
        activeCompetitionId={activeCompetitionId}
        onSaveResult={async (raceId, resultDoc) => {
          try {
            await setDoc(doc(firestoreDb, "results", raceId), {
              raceId,
              ...resultDoc,
              updatedAt: serverTimestamp(),
            });

            const race =
              visibleRaces.find((r) => r.id === raceId) ||
              races.find((r) => r.id === raceId);

            showMessage("Result saved ✅", `${race?.name}\nResults updated`);
          } catch (e) {
            showMessage("Error saving result", e.message);
          }
        }}
        onClearResults={async () => {
          const clearAllResults = async () => {
            const snapshot = await getDocs(collection(firestoreDb, "results"));
            for (const docSnap of snapshot.docs) {
              await deleteDoc(docSnap.ref);
            }
          };

          if (Platform.OS === "web") {
            if (!window.confirm("Are you sure you want to clear ALL results?")) return;

            try {
              await clearAllResults();
              showMessage("Results cleared", "All race results have been removed.");
            } catch (e) {
              showMessage("Error clearing results", e.message);
            }
            return;
          }

          Alert.alert("Confirm", "Clear ALL results?", [
            { text: "Cancel", style: "cancel" },
            {
              text: "Clear",
              style: "destructive",
              onPress: async () => {
                try {
                  await clearAllResults();
                  showMessage("Results cleared", "All race results have been removed.");
                } catch (e) {
                  showMessage("Error clearing results", e.message);
                }
              },
            },
          ]);
        }}
      />

      <FooterBar
        active={activeTab}
        onGoHome={() => setScreen("home")}
        onGoRaces={() => setScreen("races")}
        onGoMyTips={() => setScreen("myTips")}
        onGoLeaderboard={() => setScreen("leaderboard")}
        onGoResults={() => setScreen("results")}
      />
    </View>
  );
}


if (screen === "leaderboard") {
  return (
    <View style={{ flex: 1, paddingBottom: FOOTER_HEIGHT }}>
<TopBar
  onLogout={() => signOut(auth)}
  onProfile={() => setScreen("profile")}
  onAdmin={isAdmin ? () => setScreen("adminSelectCompetition") : null}
/>
      <LeaderboardScreen
  currentUserId={user.uid}
  onBack={() => setScreen("home")}
  activeCompetitionId={activeCompetitionId} // ✅ ADD
  registeredUserIds={registeredUserIds}
/>

      <FooterBar
        active={activeTab}
        onGoHome={() => setScreen("home")}
        onGoRaces={() => setScreen("races")}
        onGoMyTips={() => setScreen("myTips")}
        onGoLeaderboard={() => setScreen("leaderboard")}
        onGoResults={() => setScreen("results")}
      />
    </View>
  );
}


  return (
    <View style={{ flex: 1, paddingBottom: FOOTER_HEIGHT }}>
<TopBar
  onLogout={() => signOut(auth)}
  onProfile={() => setScreen("profile")}
  onAdmin={isAdmin ? () => setScreen("adminSelectCompetition") : null}
/>
      <HomeScreen
  userEmail={user.email}
  isAdmin={isAdmin}
  missingDisplayName={missingDisplayName}
  goProfile={() => setScreen("profile")}
        todayRank={homeLeaderboard.dayRank}
        todayTotalUsers={homeLeaderboard.dayTotalUsers}
        todayWinnings={homeLeaderboard.dayWinnings}
        cumulativeRank={homeLeaderboard.allRank}
        cumulativeTotalUsers={homeLeaderboard.allTotalUsers}
        cumulativeWinnings={homeLeaderboard.allWinnings}
        races={visibleRaces}
        results={results}
        nowTick={nowTick}
        onGoRaces={() => setScreen("races")}
        onGoMyTips={() => setScreen("myTips")}
        onGoRules={() => setScreen("rules")}
        onGoAdmin={isAdmin ? () => setScreen("admin") : null}
        onGoLeaderboard={() => setScreen("leaderboard")}
        onGoResults={() => setScreen("results")}
      />
      <FooterBar
        active={activeTab}
        onGoHome={() => setScreen("home")}
        onGoRaces={() => setScreen("races")}
        onGoMyTips={() => setScreen("myTips")}
        onGoLeaderboard={() => setScreen("leaderboard")}
        onGoResults={() => setScreen("results")}
      />
    </View>
  );
}

function AdminEntrantsScreen({
  competitions,
  activeCompetitionId,
  usersMap,
  onBack,
}) {
  const activeCompetition =
    (competitions ?? []).find((c) => c.id === activeCompetitionId) ?? null;

  const rows = useMemo(() => {
  const list = Object.entries(usersMap ?? {}).map(([uid, u]) => {
    const displayName = String(u?.displayName ?? "").trim();
    const username = String(u?.username ?? "").trim();
    const registeredIds = Array.isArray(u?.registeredCompetitionIds)
      ? u.registeredCompetitionIds
      : [];

    const nameToShow = displayName || username || "(No screen name)";

    return {
      uid,
      displayName: nameToShow,
      sortKey: nameToShow.toLowerCase(),
      registered: activeCompetitionId
        ? registeredIds.includes(activeCompetitionId)
        : false,
      isPaid: !!u?.isPaid,
    };
  });

  list.sort((a, b) => a.sortKey.localeCompare(b.sortKey));
  return list;
}, [usersMap, activeCompetitionId]);

  const toggleRegistered = async (uid, nextVal) => {
    if (!activeCompetitionId) return;

    try {
      const userRef = doc(firestoreDb, "users", uid);

      if (nextVal) {
        await setDoc(
          userRef,
          { registeredCompetitionIds: arrayUnion(activeCompetitionId) },
          { merge: true }
        );

        const overallRef = doc(
          firestoreDb,
          "competitions",
          activeCompetitionId,
          "leaderboard",
          uid
        );

        const displayNameLower = String(usersMap?.[uid]?.displayName ?? "")
          .trim()
          .toLowerCase();

        await setDoc(
          overallRef,
          {
            totalReturnInclStake: 0,
            tips: 0,
            createdAt: serverTimestamp(),
            displayNameLower,
            updatedAt: serverTimestamp(),
          },
          { merge: true }
        );
      } else {
        await setDoc(
          userRef,
          { registeredCompetitionIds: arrayRemove(activeCompetitionId) },
          { merge: true }
        );
      }
    } catch (e) {
      showMessage("Save failed", e.message);
    }
  };

  const togglePaid = async (uid, nextVal) => {
    try {
      const userRef = doc(firestoreDb, "users", uid);

      await setDoc(
        userRef,
        {
          isPaid: nextVal,
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );
    } catch (e) {
      showMessage("Save failed", e.message);
    }
  };

  return (
    <View style={styles.container}>
      <ScrollView
        style={styles.content}
        contentContainerStyle={{ paddingBottom: 40 }}
      >
        <Text style={styles.title}>Manage entrants</Text>

        <View style={[styles.card, { marginTop: 8 }]}>
          <Text style={styles.h2}>Active competition</Text>
          <Text style={styles.cardTitle}>
            {activeCompetition?.name
              ? activeCompetition.name
              : "No active competition set"}
          </Text>
          <Text style={styles.cardHint}>
            Toggle an entrant on to register them for this competition.
          </Text>
        </View>

        <View style={{ marginTop: 10, gap: 10 }}>
          {rows.map((r) => (
            <View key={r.uid} style={[styles.card, styles.entrantRow]}>
              <View style={{ flex: 1, paddingRight: 12 }}>
                <Text style={styles.cardTitle}>{r.displayName}</Text>
              </View>

              <View style={{ flexDirection: "row", alignItems: "center", gap: 18 }}>
                <View style={{ alignItems: "center" }}>
                  <Text
                    style={{
                      fontSize: 12,
                      color: THEME.text3,
                      fontWeight: "600",
                      marginBottom: 4,
                    }}
                  >
                    Registered
                  </Text>
                  <Switch
                    value={r.registered}
                    onValueChange={(val) => toggleRegistered(r.uid, val)}
                  />
                </View>

                <View style={{ alignItems: "center" }}>
                  <Text
                    style={{
                      fontSize: 12,
                      color: THEME.text3,
                      fontWeight: "600",
                      marginBottom: 4,
                    }}
                  >
                    Paid
                  </Text>
                  <Switch
                    value={r.isPaid}
                    onValueChange={(val) => togglePaid(r.uid, val)}
                  />
                </View>
              </View>
            </View>
          ))}
        </View>

        <Pressable style={[styles.button, { marginTop: 14 }]} onPress={onBack}>
          <Text style={styles.buttonText}>Back</Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}

function AuthScreen() {
  const [mode, setMode] = useState("idle"); // "idle" | "login" | "signup"
  const [username, setUsername] = useState("");
  const [pin, setPin] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);

  // Animation
  const anim = useRef(new Animated.Value(0)).current; // 0 hidden, 1 shown

  const showForm = (nextMode) => {
    setMode(nextMode);
    Animated.timing(anim, {
      toValue: 1,
      duration: 220,
      useNativeDriver: true,
    }).start();
  };

  const hideForm = () => {
    Animated.timing(anim, {
      toValue: 0,
      duration: 180,
      useNativeDriver: true,
    }).start(() => {
      setMode("idle");
      setPin("");
    });
  };

  const signUp = async () => {
    if (!username || !pin) {
      showMessage("Missing details", "Username and PIN are required.");
      return;
    }

    if (!/^\d{4,6}$/.test(String(pin))) {
      showMessage("Invalid PIN", "PIN must be 4–6 digits.");
      return;
    }

    setBusy(true);

    try {
      console.log("SIGNUP ATTEMPT", { username, pin, email });

      await signUpWithPin({
        username: username.trim(),
        pin: String(pin),
        email: email.trim() || null,
      });

      console.log("SIGNUP SUCCESS");

      showMessage("Account created", "You are now logged in.");
    } catch (e) {
      console.log("SIGNUP ERROR", e);

      const msg =
        e?.details ||
        e?.message ||
        e?.code ||
        JSON.stringify(e);

      showMessage("Sign up failed", msg);
    } finally {
      setBusy(false);
    }
  };

  const login = async () => {
    if (!username || !pin) {
      showMessage("Missing details", "Enter username and PIN.");
      return;
    }

    setBusy(true);

    try {
      console.log("LOGIN ATTEMPT", { username, pin });

      const res = await loginWithPin({
        username: username.trim(),
        pin: String(pin),
      });

      console.log("LOGIN SUCCESS", res);
    } catch (e) {
      console.log("LOGIN ERROR", e);

      const msg =
        e?.details ||
        e?.message ||
        e?.code ||
        JSON.stringify(e);

      showMessage("Login failed", msg);
    } finally {
      setBusy(false);
    }
  };

  const sendMagicLink = async () => {
    if (!username) {
      showMessage("Missing username", "Enter your username first.");
      return;
    }

    setBusy(true);

    try {
      console.log("MAGIC LINK REQUEST", { username });

      const res = await requestMagicLink({
        username: username.trim(),
      });

      console.log("MAGIC LINK RESPONSE", res);

      showMessage(
        "Check your email",
        "If your account has an email saved, a magic login link has been sent."
      );
    } catch (e) {
      console.log("MAGIC LINK ERROR", e);

      const msg =
        e?.details ||
        e?.message ||
        e?.code ||
        JSON.stringify(e);

      showMessage("Error", msg);
    } finally {
      setBusy(false);
    }
  };

  const formVisible = mode !== "idle";
  const isSignup = mode === "signup";

  // Animated styles
  const formAnimatedStyle = {
    opacity: anim,
    transform: [
      {
        translateY: anim.interpolate({
          inputRange: [0, 1],
          outputRange: [10, 0],
        }),
      },
    ],
  };

  return (
    <View style={styles.authBg}>
      <View style={styles.heroOverlay}>
        <View style={styles.cardStack}>
          <View style={styles.authBadge}>
            <Text style={styles.heroBadgeIcon}>🔒</Text>
          </View>

          <View style={styles.heroCard}>
            <Text style={styles.authTitle}>
              Thornton Cricket Club Cheltenham{"\n"}Tipping Competition
            </Text>

            <Text style={styles.authSubtitle}>
              Enter your username and PIN to register or log in to play
            </Text>

            {/* FORM (animated) */}
            {formVisible && (
              <Animated.View style={[styles.authForm, formAnimatedStyle]}>
                <TextInput
                  placeholder="Username"
                  value={username}
                  onChangeText={setUsername}
                  autoCapitalize="none"
                  style={styles.input}
                  editable={!busy}
                />

                <TextInput
                  placeholder="PIN (4-6 digits)"
                  value={pin}
                  onChangeText={setPin}
                  keyboardType="number-pad"
                  secureTextEntry
                  style={styles.input}
                  editable={!busy}
                />

                {isSignup && (
                  <TextInput
                    placeholder="Email (optional)"
                    value={email}
                    onChangeText={setEmail}
                    autoCapitalize="none"
                    keyboardType="email-address"
                    style={styles.input}
                    editable={!busy}
                  />
                )}

                {mode === "login" ? (
                  <Pressable
                    style={[
                      styles.button,
                      styles.buttonPrimary,
                      busy && styles.buttonDisabled,
                    ]}
                    onPress={login}
                    disabled={busy}
                  >
                    <Text style={styles.buttonText}>
                      {busy ? "Working…" : "Log In"}
                    </Text>
                  </Pressable>
                ) : (
                  <Pressable
                    style={[
                      styles.button,
                      styles.buttonPrimary,
                      busy && styles.buttonDisabled,
                    ]}
                    onPress={signUp}
                    disabled={busy}
                  >
                    <Text style={styles.buttonText}>
                      {busy ? "Working…" : "Create Account"}
                    </Text>
                  </Pressable>
                )}

                <Pressable
                  style={[styles.button, styles.authSecondaryBtn]}
                  onPress={hideForm}
                  disabled={busy}
                >
                  <Text style={styles.buttonText}>Back</Text>
                </Pressable>
              </Animated.View>
            )}

            {mode === "idle" && (
              <View style={styles.authForm}>
                <Pressable
                  style={[styles.button, styles.buttonPrimary]}
                  onPress={() => showForm("login")}
                  disabled={busy}
                >
                  <Text style={styles.buttonText}>Log In</Text>
                </Pressable>

                <Pressable
                  style={[styles.button, styles.authSecondaryBtn]}
                  onPress={() => showForm("signup")}
                  disabled={busy}
                >
                  <Text style={styles.buttonText}>Create Account</Text>
                </Pressable>

                <Pressable
                  style={[styles.button, styles.authSecondaryBtn]}
                  onPress={() => showForm("login")}
                  disabled={busy}
                >
                  <Text style={styles.buttonTextEmail}>
                    Sign in using email link (must be registered)
                  </Text>
                </Pressable>
              </View>
            )}

            {mode === "login" && (
              <Pressable
                style={[
                  styles.button,
                  styles.authSecondaryBtn,
                  busy && styles.buttonDisabled,
                ]}
                onPress={sendMagicLink}
                disabled={busy}
              >
                <Text style={styles.buttonText}>
                  Sign in using email link (no password)
                </Text>
              </Pressable>
            )}

            <Text style={styles.authHint}>
              Any identifiable data collected during this competition will be
              securely stored and used solely for the purpose of managing the
              tipping competition. We will not share your information with third
              parties, and it will be deleted after the competition concludes.
              By participating, you consent to this data usage policy.
            </Text>
          </View>
        </View>
      </View>
    </View>
  );
}

function HomeScreen({
  userEmail,
  races,
  results,
  nowTick,
  isAdmin,
  missingDisplayName,
  goProfile,
  todayRank,
  todayTotalUsers,
  todayWinnings,
  cumulativeRank,
  cumulativeTotalUsers,
  cumulativeWinnings,
  onGoRaces,
  onGoMyTips,
  onGoRules,
  onGoAdmin,
  onGoLeaderboard,
  onGoResults,
}) {
  const { width } = useWindowDimensions();
  const contentWidth = Math.min(width, 520) - 32; // maxWidth - paddingHorizontal*2

  // ✅ Carousel: 2 slides (Last result, Next race)
  const carouselRef = useRef(null);
  const [carouselIndex, setCarouselIndex] = useState(0);

  const formatTimeUK = (ms) => {
    if (!ms) return "TBA";
    return new Date(ms).toLocaleTimeString("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "Europe/London",
    });
  };

  const lastResult = useMemo(() => {
    const completed = (races ?? [])
      .filter((r) => !!results?.[r.id])
      .slice()
      .sort((a, b) => {
        // Prefer lockAt ordering, else fall back to date+order
        const ak = a.lockAt || 0;
        const bk = b.lockAt || 0;
        if (ak !== bk) return ak - bk;
        const ad = `${a.date ?? ""}_${String(a.order ?? 0).padStart(3, "0")}`;
        const bd = `${b.date ?? ""}_${String(b.order ?? 0).padStart(3, "0")}`;
        return ad.localeCompare(bd);
      });

    const race = completed.length ? completed[completed.length - 1] : null;
    if (!race) return null;

    const res = results?.[race.id];
    const winner = res?.placements?.find((p) => p.position === 1);
    return {
      raceName: race.name ?? "Last result",
      winnerHorse: winner?.horseName ?? getWinnerHorse(res) ?? "—",
      odds: winner?.oddsDisplay ?? winner?.oddsDecimal ?? "—",
    };
  }, [races, results]);

  const nextRace = useMemo(() => {
    const now = Date.now();
    const upcoming = (races ?? [])
      .filter((r) => typeof r.lockAt === "number" && r.lockAt > now)
      .slice()
      .sort((a, b) => (a.lockAt ?? 0) - (b.lockAt ?? 0));

    const race = upcoming.length ? upcoming[0] : null;
    if (!race) return null;

    const mins = Math.max(0, Math.ceil((race.lockAt - now) / 60000));
    return {
      raceName: race.name ?? "Next race",
      startsAt: race.lockAt,
      minutesToStart: mins,
    };
  }, [races, nowTick]);

  // Auto-advance every 3 seconds
  useEffect(() => {
    const id = setInterval(() => {
      setCarouselIndex((prev) => {
        const next = (prev + 1) % 2;
        carouselRef.current?.scrollToOffset({
          offset: next * contentWidth,
          animated: true,
        });
        return next;
      });
    }, 6000);

    return () => clearInterval(id);
  }, [contentWidth]);

  // ✅ CTA animation (slick press + subtle shine)
  const ctaScale = useRef(new Animated.Value(1)).current;
  const sheenX = useRef(new Animated.Value(-120)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(sheenX, {
          toValue: 240,
          duration: 1600,
          useNativeDriver: false,
        }),
        Animated.timing(sheenX, {
          toValue: -120,
          duration: 0,
          useNativeDriver: false,
        }),
        Animated.delay(1800),
      ])
    );

    loop.start();
    return () => loop.stop();
  }, [sheenX]);

  const onCtaPressIn = () => {
    Animated.spring(ctaScale, {
      toValue: 0.98,
      useNativeDriver: true,
      speed: 24,
      bounciness: 6,
    }).start();
  };

  const onCtaPressOut = () => {
    Animated.spring(ctaScale, {
      toValue: 1,
      useNativeDriver: true,
      speed: 24,
      bounciness: 6,
    }).start();
  };

  const AnimatedPressable = useMemo(
    () => Animated.createAnimatedComponent(Pressable),
    []
  );

  return (
    <View style={styles.container}>
      <ScrollView
        style={styles.content}
        contentContainerStyle={{ paddingBottom: FOOTER_HEIGHT + 24 }}
        showsVerticalScrollIndicator={false}
      >

        {/* Hero banner */}
        <View
  style={[
    styles.heroWrap,
    {
      width: contentWidth,
      alignSelf: "center",
      overflow: "hidden",
      renderToHardwareTextureAndroid: true,

      // ✅ allow the hero to grow with the card
      minHeight: Math.max(320, Math.round(contentWidth * 0.75)),
    },
  ]}
>
          <ImageBackground
            // TODO: replace this with your provided hero image (local require or remote uri)
            source={HERO_IMAGE}
            style={styles.heroBg}
            imageStyle={styles.heroBgImage}
            resizeMode="cover"
          >
            <View style={[styles.heroOverlay, { paddingBottom: 110 }]}>
              <View style={styles.heroCard}>
                <View style={styles.heroBadge}>
                  <Text style={styles.heroBadgeIcon}>🏆</Text>
                </View>

                <Text style={styles.heroKicker}>
                  TOTAL PRIZE POT FOR THE COMPETITION
                </Text>
                <Text style={styles.heroHeadline}>£- DAILY</Text>
                <Text style={styles.heroHeadline}>£- OVERALL</Text>
                <Text style={styles.heroSub}>
                  We will confirm total payouts once we have a confirmed amount of entries.
                </Text>

                <AnimatedPressable
                  onPress={onGoRaces}
                  onPressIn={onCtaPressIn}
                  onPressOut={onCtaPressOut}
                  style={[
                    styles.heroCta,
                    {
                      transform: [{ scale: ctaScale }],
                    },
                  ]}
                >
                  {/* sheen */}
                  <Animated.View
                    pointerEvents="none"
                    style={[
                      styles.heroCtaSheen,
                      { transform: [{ translateX: sheenX }, { rotate: "20deg" }] },
                    ]}
                  />
                  <Text style={styles.heroCtaText}>TAP TO MAKE YOUR PICKS FOR DAY 1</Text>
                </AnimatedPressable>
              </View>
            </View>
          </ImageBackground>
        </View>
        {missingDisplayName && (
  <Pressable
    onPress={goProfile}
    style={styles.displayNameAlert}
  >
    <Text style={styles.displayNameAlertText}>
      ⚠ Set a display name so we can identify you on the leaderboard.
    </Text>

    <Text style={styles.displayNameAlertLink}>
      Tap here to update your profile →
    </Text>
  </Pressable>
)}

<Pressable style={styles.rulesButton} onPress={onGoRules}>
  <Text style={styles.rulesButtonText}>View Competition Rules</Text>
</Pressable>

        <View style={styles.statsRow}>
          {/* LEFT: Today */}
          <View style={styles.statCard}>
            <Text style={styles.statHeading}>Today’s ranking</Text>

            {/* ✅ NEW layout: "#2 • of 2" on one line */}
            <Text style={styles.statNumber}>
              {todayRank ? `#${todayRank}` : "—"}
              {todayRank ? ` of ${todayTotalUsers}` : ""}
            </Text>

            {/* ✅ NEW layout: amount on its own line */}
            <Text style={styles.statLabel}>{formatGBP(todayWinnings)}</Text>
          </View>

          {/* RIGHT: Cumulative */}
          <View style={styles.statCard}>
            <Text style={styles.statHeading}>Overall ranking</Text>

            {/* ✅ NEW layout: "#1 • of 5" on one line */}
            <Text style={styles.statNumber}>
              {cumulativeRank ? `#${cumulativeRank}` : "—"}
              {cumulativeRank ? ` of ${cumulativeTotalUsers}` : ""}
            </Text>

            {/* ✅ NEW layout: amount on its own line */}
            <Text style={styles.statLabel}>{formatGBP(cumulativeWinnings)}</Text>
          </View>
        </View>

        {/* ✅ NEW: Carousel below the 2 total boxes */}
        <View style={styles.carouselWrap}>
          <FlatList
            ref={carouselRef}
            data={[{ key: "last" }, { key: "next" }]}
            keyExtractor={(item) => item.key}
            horizontal
            pagingEnabled
            showsHorizontalScrollIndicator={false}
            onMomentumScrollEnd={(e) => {
              const idx = Math.round(e.nativeEvent.contentOffset.x / contentWidth);
              setCarouselIndex(idx);
            }}
            renderItem={({ item }) => {
              if (item.key === "last") {
                return (
                  <View style={[styles.carouselSlide, { width: contentWidth }]}>
                    <Text style={styles.carouselKicker}>Last result</Text>
                    <Text style={styles.carouselTitle}>
                      {lastResult?.raceName ?? "No results yet"}
                    </Text>
                    <Text style={styles.carouselBody}>
                      Winner: {lastResult?.winnerHorse ?? "—"}
                    </Text>
                    <Text style={styles.carouselBody}>
                      Odds: {String(lastResult?.odds ?? "—")}
                    </Text>
                  </View>
                );
              }

              return (
                <View style={[styles.carouselSlide, { width: contentWidth }]}>
                  <Text style={styles.carouselKicker}>Next race</Text>
                  <Text style={styles.carouselTitle}>
                    {nextRace?.raceName ?? "No upcoming races"}
                  </Text>
                  <Text style={styles.carouselBody}>
                    Starts: {formatTimeUK(nextRace?.startsAt)}
                  </Text>
                  <Text style={styles.carouselBody}>
                    {nextRace ? `${nextRace.minutesToStart} minutes to start` : "—"}
                  </Text>
                </View>
              );
            }}
          />

          <View style={styles.carouselDots}>
            <View
              style={[
                styles.carouselDot,
                carouselIndex === 0 && styles.carouselDotActive,
              ]}
            />
            <View
              style={[
                styles.carouselDot,
                carouselIndex === 1 && styles.carouselDotActive,
              ]}
            />
          </View>
        </View>

        <StatusBar style="auto" />
      </ScrollView>
    </View>
  );
}

function ResultsScreen({ races, results, allTips, activeDay, onBack }) {
  const [nowTick, setNowTick] = useState(Date.now());
  const [selectedDay, setSelectedDay] = useState(null);
  const [expanded, setExpanded] = useState({}); // raceId -> bool

  // keep time moving so "future day" can appear as soon as the first race starts
  useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), 60000);
    return () => clearInterval(id);
  }, []);

  const formatDayLabel = (dayStr) => {
  const s = String(dayStr ?? "").trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return s;

  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const da = Number(m[3]);

  // Use UTC to avoid platform parsing quirks
  const d = new Date(Date.UTC(y, mo, da));

  return d.toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "Europe/London",
  });
};

  const formatTimeUK = (ms) => {
    if (!ms) return "TBA";
    return new Date(ms).toLocaleTimeString("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "Europe/London",
    });
  };

// Visible days for the current competition
  const visibleDays = useMemo(() => getRaceDays(races ?? []), [races]);

  // Keep selected day valid as days become visible / races load
  useEffect(() => {
    if (!visibleDays.length) {
      setSelectedDay(null);
      return;
    }

    // prefer activeDay if it's visible, else first visible day
    const preferred =
      (activeDay && visibleDays.includes(activeDay) ? activeDay : null) ?? visibleDays[0];

    if (!selectedDay || !visibleDays.includes(selectedDay)) {
      setSelectedDay(preferred);
    }
  }, [visibleDays, activeDay, selectedDay]);

  const dayRaces = useMemo(() => {
    if (!selectedDay) return [];
    return (races ?? [])
      .filter((r) => r.date === selectedDay)
      .slice()
      .sort((a, b) => (Number(a.order ?? 0) - Number(b.order ?? 0)));
  }, [races, selectedDay]);

const toggleRace = (raceId) => {
  setExpanded((prev) => {
    const nextOpen = !prev[raceId];
    gaEvent("results_toggle", {
      race_id: raceId,
      action: nextOpen ? "open" : "close",
      day: selectedDay ?? "",
    });
    return { ...prev, [raceId]: nextOpen };
  });
};

  const countWinningTips = (raceId, winnerHorse) => {
    if (!winnerHorse) return 0;
    const list = allTips ?? [];
    return list.filter((t) => t?.raceId === raceId && t?.horseName === winnerHorse).length;
  };

  return (
    <View style={styles.container}>
      <ScrollView
        style={styles.content}
        contentContainerStyle={{ paddingBottom: FOOTER_HEIGHT + 40 }}
        showsVerticalScrollIndicator={false}
      >
        <Text style={styles.title}>Results</Text>

        {/* Day toggle (only visible days) */}
        {!!visibleDays?.length && (
          <View style={{ flexDirection: "row", gap: 10, marginVertical: 10 }}>
            {visibleDays.filter(isISODate).map((d) => {
              const active = d === selectedDay;
              return (
                <Pressable
                  key={d}
                  onPress={() => setSelectedDay(d)}
                  style={[styles.smallChoice, active && styles.cardActive, { flex: 1 }]}
                >
                  <Text style={styles.smallChoiceText}>{formatDayLabel(d)}</Text>
                </Pressable>
              );
            })}
          </View>
        )}

        {!visibleDays.length ? (
          <Text style={styles.subtitle}>No results available yet.</Text>
        ) : !selectedDay ? (
          <Text style={styles.subtitle}>Select a day.</Text>
        ) : dayRaces.length === 0 ? (
          <Text style={styles.subtitle}>No races found for this day.</Text>
        ) : (
          <View style={{ marginTop: 6, gap: 10 }}>
            {dayRaces.map((r) => {
              const res = results?.[r.id];

              // Winner (supports old string results too)
              const winnerHorse = getWinnerHorse(res);

              // Odds (best effort)
              let winnerOdds = "—";
              if (res && typeof res !== "string") {
                const w = res?.placements?.find((p) => p.position === 1);
                winnerOdds = w?.oddsDisplay || (w?.oddsDecimal ? String(w.oddsDecimal) : "—");
              }

              const winningTips = countWinningTips(r.id, winnerHorse);
              const isOpen = !!expanded[r.id];

              return (
                <View key={r.id} style={[styles.card, styles.cardAlt]}>
                  {/* BAR (name + start time) */}
                  <Pressable onPress={() => toggleRace(r.id)} hitSlop={10}>
<View style={styles.raceCardHeaderRow}>
  <View style={{ flex: 1 }}>
    <Text style={styles.cardTitle}>
      {`${String(r.offTime ?? "").trim() || formatTimeUK(r.lockAt)} ${r.name}`}
    </Text>
  </View>

  <View style={styles.raceExpandBtn}>
    <Text style={styles.raceExpandIcon}>{isOpen ? "▴" : "▾"}</Text>
  </View>
</View>
                  </Pressable>

                  {/* EXPANDED CONTENT */}
{/* EXPANDED CONTENT */}
{isOpen && (
  <View style={{ marginTop: 10 }}>
    {!res ? (
      <Text style={styles.cardHint}>Result: pending</Text>
    ) : typeof res === "string" ? (
      // Backwards compatible: old winner-only result
      <>
        <Text style={styles.cardHint}>Winner: {res}</Text>
      </>
    ) : (
      (() => {
        const placements = Array.isArray(res.placements) ? res.placements : [];
        const sortedPlacements = placements
          .slice()
          .filter((p) => p?.horseName)
          .sort((a, b) => Number(a.position ?? 999) - Number(b.position ?? 999));

        if (!sortedPlacements.length) {
          return <Text style={styles.cardHint}>Result: pending</Text>;
        }

        // Count tips for a specific horse in this race
        const countTipsForHorse = (raceId, horseName) => {
          if (!horseName) return 0;
          const list = allTips ?? [];
          return list.filter((t) => t?.raceId === raceId && t?.horseName === horseName).length;
        };

        const tipLabel = (n) => `${n} ${n === 1 ? "tip" : "tips"}`;

        return (
          <>
            {/* Show ALL placed horses including winner, with tip counts on each row */}
            <View style={{ marginTop: 8, gap: 6 }}>
              {sortedPlacements.map((p) => {
                const pos = Number(p.position);
                const posLabel =
                  pos === 1 ? "1st" :
                  pos === 2 ? "2nd" :
                  pos === 3 ? "3rd" :
                  `${pos}th`;

                const odds =
                  p.oddsDisplay || (p.oddsDecimal ? String(p.oddsDecimal) : "—");

                const tips = countTipsForHorse(r.id, p.horseName);

                return (
                  <View
                    key={`${r.id}_${pos}_${p.horseName}`}
                    style={styles.placementRow}
                  >
                    <Text style={[styles.cardHint, styles.placementText]}>
                      {posLabel}: {p.horseName} {odds !== "—" ? `(${odds})` : ""}
                    </Text>

                    <View style={styles.tipsPill}>
                      <Text style={styles.tipsPillText}>{tipLabel(tips)}</Text>
                    </View>
                  </View>
                );
              })}
            </View>
          </>
        );
      })()
    )}
  </View>
)}
                </View>
              );
            })}
          </View>
        )}

        <StatusBar style="auto" />
      </ScrollView>
    </View>
  );
}

function ProfileScreen({ user, onBack }) {
  const [loading, setLoading] = useState(true);
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState(""); // ✅ NEW
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const ref = doc(firestoreDb, "users", user.uid);

    const unsub = onSnapshot(
      ref,
      (snap) => {
        const data = snap.exists() ? snap.data() : null;
        setDisplayName(data?.displayName ?? "");
        // ✅ NEW: prefer Firestore email, fallback to auth user email
        setEmail(data?.email ?? user.email ?? "");
        setLoading(false);
      },
      (err) => {
        setLoading(false);
        showMessage("Profile error", err.message);
      }
    );

    return unsub;
  }, [user.uid, user.email]);

  const save = async () => {
    if (!displayName) {
      showMessage("Name required", "Please enter a display name.");
      return;
    }

    setSaving(true);
    try {
      // Enforce uniqueness (exact match, NO trim, NO normalisation)
      const q = query(
        collection(firestoreDb, "users"),
        where("displayName", "==", displayName),
        limit(1)
      );

      const snap = await getDocs(q);
      const takenByAnotherUser = !snap.empty && snap.docs[0].id !== user.uid;

      if (takenByAnotherUser) {
        showMessage("Name taken", "That display name is already in use.");
        setSaving(false);
        return;
      }

      await setDoc(
  doc(firestoreDb, "users", user.uid),
  {
    displayName: displayName,
    email: email ?? user.email ?? "",
    updatedAt: serverTimestamp(),
  },
  { merge: true }
);

      showMessage("Saved ✅", "Your details have been updated.");
    } catch (e) {
      showMessage("Save failed", e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <View style={styles.container}>
      <View style={styles.content}>
        <Text style={styles.title}>Profile</Text>

        {loading ? (
          <Text style={styles.subtitle}>Loading profile…</Text>
        ) : (
          <>
            <Text style={styles.subtitle}>Display name (shown on leaderboard)</Text>

            <TextInput
              value={displayName}
              placeholderTextColor={THEME.text3}
              onChangeText={setDisplayName}
              placeholder="Enter display name"
              style={styles.input}
            />

            {/* ✅ NEW: Email field */}
            <Text style={[styles.subtitle, { marginTop: 14 }]}>Email address (For password recovery)</Text>

            <TextInput
  value={email}
  onChangeText={setEmail}
  placeholderTextColor={THEME.text3}
  editable={true}
  selectTextOnFocus={true}
  keyboardType="email-address"
  autoCapitalize="none"
  autoCorrect={false}
  style={styles.input}
/>

            <Pressable
              style={[
                styles.button,
                styles.buttonPrimary,
                saving ? styles.buttonDisabled : null,
              ]}
              onPress={save}
              disabled={saving}
            >
              <Text style={styles.buttonText}>{saving ? "Saving…" : "Save"}</Text>
            </Pressable>
          </>
        )}

        <StatusBar style="auto" />
      </View>
    </View>
  );
}

// ✅ NOTE: Make sure you have this import at the top of the file:
// import { Animated } from "react-native";

function RacesScreen({ races, racesLoading, activeDay, tips, onBack, onPickTip, allTips }) {
  const [now, setNow] = useState(Date.now());
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [horseSort, setHorseSort] = useState("odds"); // "odds" | "number"

  // ✅ Transition anim for switching races (auto-advance + manual tab)
  const raceTransition = useRef(new Animated.Value(1)).current;
  const playRaceTransition = () => {
    raceTransition.setValue(0);
    Animated.timing(raceTransition, {
      toValue: 1,
      duration: 220,
      useNativeDriver: true,
    }).start();
  };

  // Update once per minute
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60000);
    return () => clearInterval(id);
  }, []);

  const visibleRaces = useMemo(() => {
    if (!activeDay) return [];
    return races.filter((r) => r.date === activeDay);
  }, [races, activeDay]);

  // Keep index valid
  useEffect(() => {
    if (selectedIndex > visibleRaces.length - 1) {
      setSelectedIndex(0);
    }
  }, [visibleRaces.length, selectedIndex]);

  const selectedRace = visibleRaces[selectedIndex] ?? null;

  // ✅ Play transition whenever we change selected race
  useEffect(() => {
    if (!selectedRace) return;
    playRaceTransition();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIndex]);

  const hotTip = useMemo(() => {
    if (!selectedRace?.id) return null;

    const raceTips = (allTips ?? []).filter((t) => t?.raceId === selectedRace.id);
    if (raceTips.length === 0) return null;

    const counts = new Map();
    for (const t of raceTips) {
      const name = String(t?.horseName ?? "").trim();
      if (!name) continue;
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }

    let bestHorse = null;
    let bestCount = 0;

    for (const [horseName, tipCount] of counts.entries()) {
      if (tipCount > bestCount) {
        bestHorse = horseName;
        bestCount = tipCount;
      }
    }

    return bestHorse ? { horseName: bestHorse, tipCount: bestCount } : null;
  }, [allTips, selectedRace?.id]);

  // Current user's saved tip(s) for this day (one per raceId)
  const tipByRaceId = useMemo(() => {
    const map = {};
    (tips ?? []).forEach((t) => {
      if (t?.raceId) map[t.raceId] = t;
    });
    return map;
  }, [tips]);

  const findNextUntippedIndex = (fromIndex, justTippedRaceId) => {
    if (!visibleRaces.length) return null;

    for (let i = fromIndex + 1; i < visibleRaces.length; i++) {
      const rid = visibleRaces[i]?.id;
      const alreadyTipped = rid === justTippedRaceId || !!tipByRaceId[rid];
      if (!alreadyTipped) return i;
    }

    for (let i = 0; i < fromIndex; i++) {
      const rid = visibleRaces[i]?.id;
      const alreadyTipped = rid === justTippedRaceId || !!tipByRaceId[rid];
      if (!alreadyTipped) return i;
    }

    return null; // everything is tipped
  };

  const handlePickTip = async (raceId, horseName, wasSelected) => {
    await onPickTip(raceId, horseName, wasSelected);

    if (!wasSelected) {
      const next = findNextUntippedIndex(selectedIndex, raceId);
      if (next !== null) setSelectedIndex(next);
    }
  };

  const currentTipHorse =
    (selectedRace?.id && tipByRaceId[selectedRace.id]?.horseName) || null;

  if (racesLoading) {
    return (
      <View style={styles.container}>
        <ScrollView
          style={styles.content}
          contentContainerStyle={{ flexGrow: 1 }}
          showsVerticalScrollIndicator={false}
        >
          <Text style={styles.title}>Upcoming Races</Text>
          <Text style={styles.subtitle}>Loading races…</Text>
        </ScrollView>
      </View>
    );
  }

  if (!selectedRace) {
    return (
      <View style={styles.container}>
        <ScrollView
          style={styles.content}
          contentContainerStyle={{ flexGrow: 1 }}
          showsVerticalScrollIndicator={false}
        >
          <Text style={styles.title}>Upcoming Races</Text>
          <Text style={styles.subtitle}>No races available.</Text>
        </ScrollView>
      </View>
    );
  }

  const lockAt = selectedRace.lockAt ?? 0;
  const remaining = lockAt ? lockAt - now : null;
  const locked = remaining !== null && remaining <= 0;
  const countdownText =
    remaining === null ? "No lock time" : formatCountdownHM(remaining);

  return (
    <View style={styles.container}>
      <ScrollView
        style={styles.content}
        contentContainerStyle={{ paddingBottom: FOOTER_HEIGHT + 24 }}
        showsVerticalScrollIndicator={false}
        stickyHeaderIndices={[1]} // 👈 the sticky child index (see below)
      >
        <Text style={styles.title}>Enter my tips</Text>

        {/* Sticky wrapper (direct child index 1) */}
        <View style={styles.stickyRaceSelectorWrap}>
          {/* 1–7 race selector */}
          <View style={styles.raceSelectorRow}>
            {visibleRaces.slice(0, 7).map((race, idx) => {
              const active = idx === selectedIndex;
              const hasTip = !!tipByRaceId[race.id];
              return (
                <Pressable
                  key={race.id}
                  onPress={() => setSelectedIndex(idx)}
                  style={[
                    styles.raceSelectorBtn,
                    active && styles.raceSelectorBtnActive,
                    hasTip && styles.raceSelectorBtnTipped,
                  ]}
                >
                  <Text
                    style={[
                      styles.raceSelectorText,
                      active && styles.raceSelectorTextActive,
                      hasTip && styles.raceSelectorTextTipped,
                    ]}
                  >
                    {idx + 1}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>

        {/* ✅ Selected race card with transition */}
        <Animated.View
          style={[
            styles.card,
            {
              opacity: raceTransition,
              transform: [
                {
                  translateX: raceTransition.interpolate({
                    inputRange: [0, 1],
                    outputRange: [14, 0],
                  }),
                },
              ],
            },
          ]}
        >
          <>
            {/* Header: title + date */}
            <View style={styles.raceHeaderTopRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.cardTitle}>
                  {(selectedRace.offTime ?? formatTimeUK(selectedRace.lockAt))}{" "}
                  {selectedRace.name}
                </Text>
                <Text style={styles.cardSubtitle}>
                  {formatDateShortUK(selectedRace.date)}
                </Text>
              </View>
            </View>

            {/* Most tipped pill on its own row (under date, above tips close) */}
            {hotTip?.horseName ? (
              <View style={styles.mostTippedInlineUnder}>
                <Flame size={18} color={THEME.primary} strokeWidth={2.5} />
                <Text style={styles.mostTippedInlineText} numberOfLines={1}>
                  Most tipped:{" "}
                  <Text style={styles.mostTippedInlineHorse}>
                    {hotTip.horseName}
                  </Text>{" "}
                  · {hotTip.tipCount} tip{hotTip.tipCount === 1 ? "" : "s"}
                </Text>
              </View>
            ) : null}

            <Text style={styles.cardHint}>
              {locked ? "Tips closed" : "Tips close in"}: {countdownText}
            </Text>

            <>
              {/* Sort toggles */}
              <View style={styles.sortRow}>
                <Pressable
                  onPress={() => setHorseSort("odds")}
                  style={[
                    styles.sortPill,
                    horseSort === "odds" && styles.sortPillActive,
                  ]}
                >
                  <Text
                    style={[
                      styles.sortPillText,
                      horseSort === "odds" && styles.sortPillTextActive,
                    ]}
                  >
                    By odds
                  </Text>
                </Pressable>

                <Pressable
                  onPress={() => setHorseSort("number")}
                  style={[
                    styles.sortPill,
                    horseSort === "number" && styles.sortPillActive,
                  ]}
                >
                  <Text
                    style={[
                      styles.sortPillText,
                      horseSort === "number" && styles.sortPillTextActive,
                    ]}
                  >
                    By number
                  </Text>
                </Pressable>
              </View>

              {/* Runners list */}
              <View style={{ gap: 10, marginTop: 10 }}>
                {(() => {
                  const raw =
                    Array.isArray(selectedRace.runners) &&
                    selectedRace.runners.length
                      ? selectedRace.runners
                      : (selectedRace.horses ?? []).map((h, i) => ({
                          number: i + 1,
                          horseName: h,
                          oddsDisplay: "",
                          oddsDecimal: 0,
                        }));

                  const withSortKeys = raw.map((r) => {
                    const od =
                      Number(r.oddsDecimal) > 0
                        ? Number(r.oddsDecimal)
                        : fractionalToDecimal(r.oddsDisplay) ?? 9999;

                    return {
                      ...r,
                      number: Number(r.number) || 0,
                      horseName: String(r.horseName ?? "").trim(),
                      oddsDisplay: String(r.oddsDisplay ?? "").trim(),

                      // Ensure jockey/trainer exist on the object used by the UI
                      jockey: String(r.jockey ?? r.jockeyName ?? "").trim(),
                      trainer: String(r.trainer ?? r.trainerName ?? "").trim(),

                      _oddsKey: od,
                    };
                  });

                  const sorted = withSortKeys
                    .filter((r) => r.horseName)
                    .slice()
                    .sort((a, b) => {
                      if (horseSort === "number") return a.number - b.number;
                      return a._oddsKey - b._oddsKey;
                    });

                  return sorted.map((r) => {
                    const oddsLabel =
                      r.oddsDisplay ||
                      (r._oddsKey !== 9999 ? String(r._oddsKey) : "—");

                    const tippedHorseId = String(
                      tipByRaceId?.[selectedRace.id]?.horseId ?? ""
                    ).trim();
                    const runnerHorseId = String(r.horseId ?? "").trim();
                    const isSelected =
                      tippedHorseId &&
                      runnerHorseId &&
                      tippedHorseId === runnerHorseId;

                    return (
                      <Pressable
                        key={`${selectedRace.id}_${r.number}_${r.horseName}`}
                        style={[
                          styles.card,
                          styles.runnerCard,
                          locked && styles.runnerCardLocked,
                          isSelected && styles.runnerCardSelected,
                        ]}
                        disabled={locked}
                        onPress={() =>
                          handlePickTip(selectedRace.id, r.horseName, isSelected)
                        }
                      >
                        {/* ✅ UPDATED RUNNER LAYOUT (PICK under number, tall odds on right) */}
                        <View style={styles.runnerRowNew}>
                          {/* LEFT STACK: number + PICK */}
                          <View style={styles.runnerLeftStack}>
                            <View style={styles.runnerInsetLeftUnified}>
                              <Text style={styles.runnerInsetText}>
                                {r.number || "—"}
                              </Text>
                            </View>

                            <View style={styles.pickUnderNumberPill}>
                              <Text style={styles.pickUnderNumberText}>
                                {isSelected ? "PICKED" : "PICK"}
                              </Text>
                            </View>
                          </View>

                          {/* CENTER: name + meta */}
                          <View style={styles.runnerMain}>
                            <Text style={styles.runnerName} numberOfLines={1}>
                              {r.horseName}
                            </Text>

                            {(r.jockey || r.trainer) ? (
                              <View style={styles.runnerMetaStack}>
                                {r.jockey ? (
                                  <View style={[styles.metaGroup, { marginBottom: 2 }]}>
                                    <Text style={styles.metaBadge}>J</Text>
                                    <Text style={styles.runnerMetaText} numberOfLines={1}>
                                      {r.jockey}
                                    </Text>
                                  </View>
                                ) : null}

                                {r.trainer ? (
                                  <View style={styles.metaGroup}>
                                    <Text style={styles.metaBadge}>T</Text>
                                    <Text style={styles.runnerMetaText} numberOfLines={1}>
                                      {r.trainer}
                                    </Text>
                                  </View>
                                ) : null}
                              </View>
                            ) : null}
                          </View>

                          {/* RIGHT: tall odds box */}
                          <View style={styles.oddsTallBox}>
                            <Text style={styles.runnerInsetText} numberOfLines={1}>
                              {oddsLabel}
                            </Text>
                          </View>
                        </View>
                      </Pressable>
                    );
                  });
                })()}
              </View>
            </>
          </>
        </Animated.View>

        <StatusBar style="auto" />
      </ScrollView>
    </View>
  );
}

function RaceDetailsScreen({ race, initialHorse, onBack, onSubmitTip }) {
  const [selectedHorse, setSelectedHorse] = useState(initialHorse ?? null);

  useEffect(() => {
    setSelectedHorse(initialHorse ?? null);
  }, [race?.id, initialHorse]);

  return (
    <View style={styles.container}>
      <View style={styles.content}>
      <Text style={styles.title}>{race.name}</Text>
      <Text style={styles.subtitle}>{formatDateShortUK(race.date)}</Text>

      <Pressable style={[styles.button, styles.smallButton, styles.buttonGhost]} onPress={onBack}>
        <Text style={styles.buttonText}>← Home</Text>
      </Pressable>

      <Text style={styles.sectionTitle}>Choose your winning horse</Text>

      <FlatList
        data={race.horses}
        keyExtractor={(h) => h}
        style={{ marginTop: 10 }}
        renderItem={({ item }) => {
          const active = item === selectedHorse;
          return (
            <Pressable
              onPress={() => setSelectedHorse(item)}
              style={[styles.card, active ? styles.cardActive : null]}
            >
              <Text style={styles.cardTitle}>{item}</Text>
              <Text style={styles.cardSubtitle}>
                {active ? "Selected ✅" : "Tap to select"}
              </Text>
            </Pressable>
          );
        }}
      />

      <Pressable
        style={[
          styles.button, styles.buttonPrimary,
          { marginTop: 10 },
          !selectedHorse ? styles.buttonDisabled : null,
        ]}
        disabled={!selectedHorse}
        onPress={() => onSubmitTip(selectedHorse)}
      >
        <Text style={styles.buttonText}>Submit Tip</Text>
      </Pressable>

      <StatusBar style="auto" />
    </View>
    </View>
  );
}

function MyTipsScreen({
  currentUserId,
  tips,
  tipsLoading,
  results,
  races,
  activeDay,
  allTips,
  usersMap,
  nowTick,
  activeCompetitionId,
  onBack,
  onClear,
  onAmendTips,
}) {
  // Visible days for the current competition
  const days = useMemo(() => getRaceDays(races ?? []), [races]);
  const [selectedDay, setSelectedDay] = useState(null);

  // Keep selected day valid when races load / change
  useEffect(() => {
    if (!days.length) {
      setSelectedDay(null);
      return;
    }

    const preferred =
      (activeDay && days.includes(activeDay) ? activeDay : null) ?? days[0];

    if (!selectedDay || !days.includes(selectedDay)) {
      setSelectedDay(preferred);
    }
  }, [days, activeDay, selectedDay]);

  // Day label formatter (NO hooks inside)
  const formatDayLabel = (dayStr) => {
    const s = String(dayStr ?? "").trim();
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return s;

    const y = Number(m[1]);
    const mo = Number(m[2]) - 1;
    const da = Number(m[3]);

    // Use UTC to avoid platform parsing quirks
    const d = new Date(Date.UTC(y, mo, da));

    return d.toLocaleDateString("en-GB", {
      weekday: "short",
      day: "numeric",
      month: "short",
      timeZone: "Europe/London",
    });
  };

  // Races for the selected day, ordered by offTime/offTimeText
  const dayRaces = useMemo(() => {
    if (!selectedDay) return [];
    return (races ?? [])
      .filter((r) => r.date === selectedDay)
      .slice()
      .sort((a, b) => {
        const at = String(a.offTimeText ?? a.offTime ?? "").trim();
        const bt = String(b.offTimeText ?? b.offTime ?? "").trim();
        const tcmp = at.localeCompare(bt);
        if (tcmp !== 0) return tcmp;
        return Number(a.order ?? 0) - Number(b.order ?? 0);
      });
  }, [races, selectedDay]);

// ✅ Logged-in user's tips for this selected day (show immediately)
const myTipsForDay = useMemo(() => {
  const list = tips ?? [];
  return list.filter((t) => {
    if (!selectedDay) return false;
    return (t?.date ?? "") === selectedDay;
  });
}, [tips, selectedDay]);

  // ✅ Map: raceId -> my tip doc
  const myTipByRaceId = useMemo(() => {
    const map = {};
    for (const t of myTipsForDay) {
      if (t?.raceId) map[t.raceId] = t;
    }
    return map;
  }, [myTipsForDay]);

  // --- Settlement-only non-runner swap notice (per race) ---
  const [settlementByRaceId, setSettlementByRaceId] = useState({});

  const horseNameForId = (raceObj, horseId) => {
    if (!raceObj || !horseId) return null;
    const runners = Array.isArray(raceObj.runners) ? raceObj.runners : [];
    const hit = runners.find((r) => String(r?.horseId ?? "").trim() === String(horseId).trim());
    return hit?.horseName ? String(hit.horseName) : null;
  };

  useEffect(() => {
    if (!currentUserId) return;
    if (!selectedDay) return;
    if (!dayRaces?.length) return;

    const unsubs = [];
    const next = {};

    // Only listen for races where I actually tipped (keeps listeners small)
    for (const r of dayRaces) {
      const tip = myTipByRaceId?.[r.id];
      if (!tip) continue;

      const ref = doc(firestoreDb, "raceSettlements", r.id, "users", currentUserId);
      const unsub = onSnapshot(
        ref,
        (snap) => {
          if (!snap.exists()) {
            setSettlementByRaceId((prev) => {
              const copy = { ...prev };
              delete copy[r.id];
              return copy;
            });
            return;
          }

          const d = snap.data() || {};
          setSettlementByRaceId((prev) => ({ ...prev, [r.id]: d }));
        },
        () => {
          // silent: settlement docs might be protected by rules if not enabled yet
        }
      );
      unsubs.push(unsub);
    }

    // Best-effort clear stale entries when switching day
    setSettlementByRaceId(next);

    return () => {
      unsubs.forEach((fn) => {
        try {
          fn();
        } catch (_) {}
      });
    };
  }, [currentUserId, selectedDay, dayRaces, myTipByRaceId]);

  return (
    <View style={[styles.container, { paddingVertical: 0 }]}>
      <FlatList
        data={dayRaces}
        keyExtractor={(r) => r.id}
        style={styles.content}
        contentContainerStyle={{ paddingTop: 16, paddingBottom: FOOTER_HEIGHT + 28 }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        ListHeaderComponent={
          <>
            <Text style={styles.title}>My saved tips</Text>

            {/* Day toggle (always 4 festival dates) */}
            {!!days?.length && (
              <View style={{ flexDirection: "row", gap: 10, marginVertical: 10 }}>
                {days.filter(isISODate).map((d) => {
                  const active = d === selectedDay;
                  return (
                    <Pressable
                      key={d}
                      onPress={() => setSelectedDay(d)}
                      style={[styles.smallChoice, active && styles.cardActive, { flex: 1 }]}
                    >
                      <Text style={styles.smallChoiceText}>{formatDayLabel(d)}</Text>
                    </Pressable>
                  );
                })}
              </View>
            )}

            {tipsLoading ? (
              <Text style={styles.subtitle}>Loading tips…</Text>
            ) : !selectedDay ? (
              <Text style={styles.subtitle}>Select a day.</Text>
            ) : dayRaces.length === 0 ? (
              <Text style={styles.subtitle}>No races found for this day.</Text>
            ) : myTipsForDay.length === 0 ? (
              <Text style={styles.subtitle}>No tips yet for this day.</Text>
            ) : null}
          </>
        }
        renderItem={({ item: race }) => {
          const myTip = myTipByRaceId[race.id];
          const picked = !!myTip?.horseName;
          const settle = settlementByRaceId?.[race.id] || null;
          const swapApplied =
            !!settle?.wasNonRunnerSwap &&
            !!settle?.originalHorseId &&
            !!settle?.effectiveHorseId &&
            settle.originalHorseId !== settle.effectiveHorseId &&
            // if tip.horseId is missing in older tips, we still show the banner
            (!myTip?.horseId || String(myTip.horseId).trim() === String(settle.originalHorseId).trim());

          const swappedToName = swapApplied
            ? horseNameForId(race, settle.effectiveHorseId) || "the favourite"
            : null;

          return (
            <View style={[styles.card, styles.cardAlt]}>
              <Text style={styles.cardTitle}>
                {`${String(race.offTimeText ?? race.offTime ?? "").trim()} ${race.name}`}
              </Text>

<View style={{ marginTop: 8 }}>
  {(() => {
    const BLANK = "\u00A0"; // keeps the inset boxes visible but “empty”

    // Try to find the runner object so we can show number + odds like the Races screen
    const runner = picked
      ? (race.runners ?? []).find((r) => r?.horseName === myTip?.horseName)
      : null;

    const horseNumber =
      picked && runner?.number ? String(runner.number) : BLANK;

    const oddsLabel =
      picked && runner?.oddsDisplay ? String(runner.oddsDisplay) : BLANK;

    return (
      <View style={[styles.card, styles.runnerCard, !picked && styles.runnerCardLocked]}>
        <View style={styles.runnerRow}>
          {/* LEFT: horse number box */}
          <View style={styles.runnerInsetLeft}>
            <Text style={styles.runnerInsetText} numberOfLines={1}>
              {horseNumber}
            </Text>
          </View>

          {/* CENTER: horse name (or “no tip” message) */}
<View style={styles.runnerCenter}>
  {/* Horse name (or no-tip message) */}
  <Text style={styles.runnerName} numberOfLines={1}>
    {picked ? myTip.horseName : "No tip submitted for this race yet"}
  </Text>

{/* Jockey + Trainer */}
{(runner?.jockey || runner?.trainer) ? (
  <View style={styles.runnerMetaRow}>
    {runner?.jockey ? (
      <View style={styles.metaGroup}>
        <Text style={styles.metaBadge}>J</Text>
        <Text style={styles.runnerMetaText} numberOfLines={1}>
          {runner.jockey}
        </Text>
      </View>
    ) : null}

    {runner?.trainer ? (
      <View style={styles.metaGroup}>
        <Text style={styles.metaBadge}>T</Text>
        <Text style={styles.runnerMetaText} numberOfLines={1}>
          {runner.trainer}
        </Text>
      </View>
    ) : null}
  </View>
) : null}

  {/* ✅ Settlement-only notice: non-runner swap applied */}
  {picked && swapApplied ? (
    <Text style={[styles.runnerMetaLineSingle, { marginTop: 2 }]} numberOfLines={2}>
      {`⚠️ Non-runner: tip swapped to favourite (${swappedToName})`}
    </Text>
  ) : null}
</View>

          {/* RIGHT: odds box */}
          <View style={styles.runnerInsetRight}>
            <Text style={styles.runnerInsetText} numberOfLines={1}>
              {oddsLabel}
            </Text>
          </View>
        </View>
      </View>
    );
  })()}
</View>
            </View>
          );
        }}
ListFooterComponent={
  !!onAmendTips ? (
    <View style={{ paddingHorizontal: 16, marginTop: 10 }}>
      <Pressable
        style={[styles.button, styles.buttonPrimary]}
        onPress={() => {
  gaEvent("change_tips_clicked", {
    competition_id: activeCompetitionId ?? "none",
    day: selectedDay ?? "",
  });
  onAmendTips?.();
}}
      >
        <Text style={styles.buttonText}>Change my tips</Text>
      </Pressable>
    </View>
  ) : (
    <View />
  )
}
      />
      <StatusBar style="auto" />
    </View>
  );
}

function LeaderboardScreen({
  currentUserId,
  onBack,
  activeCompetitionId,
}) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [usersMap, setUsersMap] = useState({});
  const [usersLoaded, setUsersLoaded] = useState(false); // ✅ NEW
  const [days, setDays] = useState([]);
  const [mode, setMode] = useState("day");
  const [selectedDay, setSelectedDay] = useState(null);

  const LEADER_ROW_HEIGHT = 74;
  const listRef = React.useRef(null);

  // ✅ NEW: two-line day label (e.g. "Sat 28\nFeb") so it wraps like Saved Tips
  const formatDayLabelTwoLines = (dayStr) => {
    const s = String(dayStr ?? "").trim();
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return s;

    const y = Number(m[1]);
    const mo = Number(m[2]) - 1;
    const da = Number(m[3]);

    // Use UTC to avoid platform parsing quirks
    const d = new Date(Date.UTC(y, mo, da));

    const oneLine = d.toLocaleDateString("en-GB", {
      weekday: "short",
      day: "numeric",
      month: "short",
      timeZone: "Europe/London",
    }); // e.g. "Sat 28 Feb"

    const parts = oneLine.split(" "); // ["Sat","28","Feb"]
    if (parts.length >= 3) {
      return `${parts[0]} ${parts[1]}\n${parts.slice(2).join(" ")}`;
    }
    return oneLine;
  };

  // Load user profiles (for display names + registration status)
  useEffect(() => {
    const unsub = onSnapshot(
      collection(firestoreDb, "users"),
      (snapshot) => {
        const map = {};
        snapshot.docs.forEach((d) => {
          map[d.id] = d.data();
        });
        setUsersMap(map);
        setUsersLoaded(true); // ✅ NEW
      },
      (err) => showMessage("Users load error", err.message)
    );

    return unsub;
  }, []);

  // ✅ Build a Set of registered userIds for the active competition
  const registeredSet = React.useMemo(() => {
    if (!activeCompetitionId) return null;
    if (!usersLoaded) return null; // ✅ NEW: don’t filter until users loaded

    const set = new Set();
    Object.entries(usersMap || {}).forEach(([uid, u]) => {
      const ids = Array.isArray(u?.registeredCompetitionIds)
        ? u.registeredCompetitionIds
        : [];
      if (ids.includes(activeCompetitionId)) set.add(uid);
    });
    return set;
  }, [usersMap, activeCompetitionId, usersLoaded]);

  // Load competition days
  useEffect(() => {
    if (!activeCompetitionId) {
      setDays([]);
      setSelectedDay(null);
      return;
    }

    const compRef = doc(firestoreDb, "competitions", activeCompetitionId);

    const unsub = onSnapshot(
      compRef,
      (snap) => {
        const data = snap.data() || {};
        const raw = Array.isArray(data.days) ? data.days : [];

        const cleaned = raw
          .map((s) => String(s).trim())
          .filter(Boolean)
          .sort();

        setDays(cleaned);

        if (cleaned.length > 0) {
          setSelectedDay((prev) =>
            prev && cleaned.includes(prev) ? prev : cleaned[cleaned.length - 1]
          );
        } else {
          setSelectedDay(null);
        }
      },
      (err) => showMessage("Competition load error", err.message)
    );

    return unsub;
  }, [activeCompetitionId]);

  // ✅ If no days exist yet, default to overall
  useEffect(() => {
    if (mode === "day" && (!days || days.length === 0)) {
      setMode("overall");
    }
  }, [mode, days]);

  // Load leaderboard rows based on mode + selectedDay
  useEffect(() => {
    if (!activeCompetitionId) {
      setRows([]);
      setLoading(false);
      return;
    }

    if (mode === "day" && !selectedDay) {
      setRows([]);
      setLoading(false);
      return;
    }

    setLoading(true);

    const baseCollection =
      mode === "overall"
        ? collection(firestoreDb, "competitions", activeCompetitionId, "leaderboard")
        : collection(
            firestoreDb,
            "competitions",
            activeCompetitionId,
            "leaderboardDays",
            selectedDay,
            "users"
          );

    const q = query(
      baseCollection,
      orderBy("totalReturnInclStake", "desc"),
      limit(200)
    );

    const unsub = onSnapshot(
      q,
      (snap) => {
        const list = snap.docs.map((d) => ({
          userId: d.id,
          ...d.data(),
        }));

        // ✅ NEW: daily leaderboards should include EVERY registered user
        // even if they have no doc yet for the day (0 tips / £0.00).
        let merged = list;

        if (registeredSet) {
          if (mode === "day") {
            const byId = new Map(list.map((r) => [r.userId, r]));

            // Add missing registered users with 0s
            registeredSet.forEach((uid) => {
              if (!byId.has(uid)) {
                byId.set(uid, {
                  userId: uid,
                  totalReturnInclStake: 0,
                  tips: 0,
                });
              }
            });

            merged = Array.from(byId.values());
          } else {
            // OVERALL: restrict to registered users
            merged = list.filter((r) => registeredSet.has(r.userId));
          }
        }

        const withNames = merged.map((r) => ({
          ...r,
          displayName:
            usersMap?.[r.userId]?.displayName ||
            usersMap?.[r.userId]?.username?.trim() ||
            usersMap?.[r.userId]?.email ||
            r.userId,
          gbp: Number(r.totalReturnInclStake ?? 0),
          tips: Number(r.tips ?? 0),
        }));

        // ✅ Ensure consistent ordering after merging in zero rows
        withNames.sort((a, b) => {
          const diff = (b.gbp ?? 0) - (a.gbp ?? 0);
          if (diff !== 0) return diff;
          const tipsDiff = (b.tips ?? 0) - (a.tips ?? 0);
          if (tipsDiff !== 0) return tipsDiff;
          return String(a.displayName ?? "").localeCompare(String(b.displayName ?? ""));
        });

        setRows(withNames);
        setLoading(false);
      },
      (err) => {
        setLoading(false);
        showMessage("Leaderboard load error", err.message);
      }
    );

    return unsub;
  }, [activeCompetitionId, usersMap, registeredSet, mode, selectedDay]);

  const myIndex = rows.findIndex((r) => r.userId === currentUserId);
  const myRow = myIndex >= 0 ? rows[myIndex] : null;

  const jumpToMe = () => {
    if (myIndex < 0) {
      showMessage(
        "Not on leaderboard",
        "Submit a tip to appear on the leaderboard."
      );
      return;
    }

    requestAnimationFrame(() => {
      try {
        listRef.current?.scrollToIndex({
          index: myIndex,
          animated: true,
          viewPosition: 0.3,
        });
      } catch (e) {
        listRef.current?.scrollToOffset({
          offset: LEADER_ROW_HEIGHT * myIndex,
          animated: true,
        });
      }
    });
  };

  const renderSegment = (label, isActive, onPress) => (
    <Pressable
      onPress={onPress}
      style={[
        styles.smallChoice,
        { flex: 1 }, // keeps equal width like segments
        isActive && styles.cardActive,
      ]}
    >
      <Text style={styles.smallChoiceText} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );

  return (
    <View style={styles.container}>
      <View style={[styles.content, { flex: 1 }]}>
        <Text style={styles.title}>Leaderboard</Text>

        {/* ✅ My Tips–style segmented selector: days + overall */}
        <View style={styles.segmentWrap}>
          {/* OVERALL – full width */}
          <Pressable
            onPress={() => setMode("overall")}
            style={[
              styles.smallChoice,
              styles.overallChoice,
              mode === "overall" && styles.cardActive,
            ]}
          >
            <Text style={styles.smallChoiceText}>Overall</Text>
          </Pressable>

          {/* DAY BUTTONS */}
          <View style={styles.segmentRow}>
            {days.map((d) => {
              const active = mode === "day" && selectedDay === d;

              return (
                <Pressable
                  key={d}
                  onPress={() => {
                    setMode("day");
                    setSelectedDay(d);
                  }}
                  style={[
                    styles.smallChoice,
                    styles.dayChoice,
                    active && styles.cardActive,
                  ]}
                >
                  <Text
                    style={[styles.smallChoiceText, styles.dayTabText]}
                    numberOfLines={2}
                    ellipsizeMode="clip"
                  >
                    {formatDayLabelTwoLines(d)}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>

        {loading ? (
          <Text style={styles.subtitle}>Loading leaderboard…</Text>
        ) : (
          <>
            {/* Your position summary */}
            <View style={[styles.card, styles.meSummaryCard]}>
              <Text style={styles.cardTitle}>
                Your position: {myRow ? `${myIndex + 1} of ${rows.length}` : "—"}
              </Text>
              <Text style={styles.cardSubtitle}>
                {myRow
                  ? `${formatGBP(myRow.gbp)} winnings`
                  : "Submit a tip to appear on the leaderboard."}
              </Text>

              <Pressable
                style={[
                  styles.button,
                  styles.smallButton,
                  myIndex < 0 && styles.buttonDisabled,
                ]}
                onPress={jumpToMe}
                disabled={myIndex < 0}
              >
                <Text style={styles.buttonText}>Jump to my row</Text>
              </Pressable>
            </View>

            {rows.length === 0 ? (
              <Text style={styles.subtitle}>
                {mode === "overall"
                  ? "No overall results yet."
                  : selectedDay
                  ? `This leaderboard will show once the first race is confirmed.`
                  : "No results yet."}
              </Text>
            ) : (
              <FlatList
                ref={listRef}
                data={rows}
                keyExtractor={(item) => item.userId}
                style={{ flex: 1, marginTop: 10 }}
                contentContainerStyle={{ paddingBottom: 16 }}
                ListFooterComponent={
                  <View style={{ height: FOOTER_HEIGHT + 28 }} />
                }
                getItemLayout={(_, index) => ({
                  length: LEADER_ROW_HEIGHT,
                  offset: LEADER_ROW_HEIGHT * index,
                  index,
                })}
                onScrollToIndexFailed={(info) => {
                  setTimeout(() => {
                    listRef.current?.scrollToOffset({
                      offset: LEADER_ROW_HEIGHT * info.index,
                      animated: true,
                    });
                  }, 50);
                }}
                renderItem={({ item, index }) => {
                  const isMe = item.userId === currentUserId;
                  const isFirst = index === 0;

                  return (
                    <View
                      style={[
                        styles.card,
                        styles.leaderRow,
                        isMe && styles.leaderboardMe,
                        isFirst && styles.leaderboardTop,
                      ]}
                    >
                      {/* LEFT INSET: position */}
                      <View
                        style={[
                          styles.leaderInsetLeft,
                          isFirst && styles.leaderInsetTop,
                        ]}
                      >
                        <Text
                          style={[
                            styles.leaderInsetText,
                            isFirst && styles.leaderInsetTextTop,
                          ]}
                        >
                          {index + 1}
                        </Text>
                      </View>

                      {/* CENTER: name + trophy for #1 */}
                      <View style={styles.leaderCenter}>
                        {isFirst && <Text style={styles.leaderTrophy}>🏆</Text>}

                        <Text
                          style={[
                            styles.leaderName,
                            isFirst && styles.leaderNameTop,
                          ]}
                        >
                          {item.displayName} {isMe ? "(You)" : ""}
                        </Text>
                      </View>

                      {/* RIGHT INSET: winnings */}
                      <View
                        style={[
                          styles.leaderInsetRight,
                          isFirst && styles.leaderInsetTop,
                        ]}
                      >
                        <Text
                          style={[
                            styles.leaderInsetText,
                            isFirst && styles.leaderInsetTextTop,
                          ]}
                        >
                          {formatGBP(item.gbp)}
                        </Text>
                      </View>
                    </View>
                  );
                }}
              />
            )}
          </>
        )}

        <StatusBar style="auto" />
      </View>
    </View>
  );
}

function RulesScreen({ onBack }) {
  return (
    <View style={styles.container}>
      <ScrollView
        style={styles.content}
        contentContainerStyle={{ paddingBottom: FOOTER_HEIGHT + 24 }}
        showsVerticalScrollIndicator={false}
      >
        <Text style={styles.title}>Competition Rules</Text>
        <Text style={styles.subtitle}>
          Please read these rules before entering your tips.
        </Text>

        <Pressable
          style={[styles.button, styles.buttonPrimary, { marginTop: 14 }]}
          onPress={onBack}
        >
          <Text style={styles.buttonText}>Back to Home</Text>
        </Pressable>

        <View style={[styles.card, { marginTop: 10 }]}>
          <Text style={styles.h2}>1. Entry</Text>
          <Text style={styles.rulestext}>
            Entry is £10 payable to Ross Soames. Only
            paid up entrants are eligible for prizes and leaderboard positions.<p>Ross Soames<br></br>
Sort Code - 070806<br></br>
Acc No. 07964444<br></br>
Ref: CC Your Name
</p>
          </Text>
        </View>

        <View style={[styles.card, { marginTop: 10 }]}>
          <Text style={styles.h2}>2. Scoring</Text>
          <Text style={styles.rulestext}>
            You have a virtual £5 each way bet on each race (£10 total per race) per day of the competition. The winnings from each race will be calculated and added to your daily total and overall total without the stake deductions.
          </Text>
        </View>

        <View style={[styles.card, { marginTop: 10 }]}>
          <Text style={styles.h2}>3. Betting rules</Text>
          <Text style={styles.rulestext}>
            Place terms as shown on Skybet (Subject to change).<br></br>
            Non-runners will be assigned the SP favourite.<br></br>
            Odds shown on the app are indicative prices. Final prices will be taken the SP on Racing Post app/website.
          </Text>
        </View>

        <View style={[styles.card, { marginTop: 10 }]}>
          <Text style={styles.h2}>4. Tipping</Text>
          <Text style={styles.rulestext}>
            Tipping for each day will lock at the start of the first race on that day (13:20). Anyone failing to make their picks will be assigned the SP favourite.<br></br>The races for the following day will automatically update at 7pm on the evening before.
          </Text>
        </View>

        <View style={[styles.card, { marginTop: 10 }]}>
          <Text style={styles.h2}>5. Winning</Text>
          <Text style={styles.rulestext}>
            Each daily winner will receive a prize and the overall winner will recieve a grand prize. In the event of a tie, the organisers will decide the split fairly.
          </Text>
        </View>

        <Pressable
          style={[styles.button, styles.buttonPrimary, { marginTop: 14 }]}
          onPress={onBack}
        >
          <Text style={styles.buttonText}>Back to Home</Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}

function AdminCompetitionHomeScreen({
  competitions,
  activeCompetitionId,
  onEnterResults,
  onManageEntrants,
  onBack,
}) {
  const activeCompetition =
    (competitions ?? []).find((c) => c.id === activeCompetitionId) ?? null;

  return (
    <View style={styles.container}>
      <View style={styles.content}>
        <Text style={styles.title}>Manage competition</Text>

        <View style={[styles.card, { marginTop: 8 }]}>
          <Text style={styles.h2}>Current active competition</Text>
          <Text style={styles.cardTitle}>
            {activeCompetition?.name ? activeCompetition.name : "No active competition set"}
          </Text>
        </View>

        <Pressable
          style={[styles.button, styles.buttonPrimary, { marginTop: 14 }]}
          onPress={onEnterResults}
          disabled={!activeCompetitionId}
        >
          <Text style={styles.buttonText}>Enter results</Text>
        </Pressable>

        <Pressable
          style={[styles.button, { marginTop: 10 }]}
          onPress={onManageEntrants}
          disabled={!activeCompetitionId}
        >
          <Text style={styles.buttonText}>Manage entrants</Text>
        </Pressable>

        <Pressable style={[styles.button, { marginTop: 10 }]} onPress={onBack}>
          <Text style={styles.buttonText}>Back</Text>
        </Pressable>
      </View>
    </View>
  );
}

function AdminScreen({
  races,
  allRaces,
  results,
  onBack,
  onSaveResult,
  onClearResults,
  competitions,
  activeCompetitionId,
}) {
  const POSITIONS = [1, 2, 3, 4, 5, 6, 7, 8];

  const activeCompetition = useMemo(() => {
    return (competitions ?? []).find((c) => c.id === activeCompetitionId) ?? null;
  }, [competitions, activeCompetitionId]);

  // ----- DAY SELECTION -----
  const days = useMemo(() => getRaceDays(races ?? []), [races]);
  const [selectedDay, setSelectedDay] = useState(null);

  useEffect(() => {
    if (!days.length) {
      setSelectedDay(null);
      return;
    }
    if (!selectedDay || !days.includes(selectedDay)) {
      setSelectedDay(days[0]);
    }
  }, [days, selectedDay]);

  const dayRaces = useMemo(() => {
    if (!selectedDay) return [];
    return (races ?? [])
      .filter((r) => r.date === selectedDay)
      .slice()
      .sort((a, b) => Number(a.order ?? 0) - Number(b.order ?? 0));
  }, [races, selectedDay]);

  // ----- RACE SELECTION -----
  const [selectedRaceId, setSelectedRaceId] = useState(null);

  useEffect(() => {
    if (!dayRaces.length) {
      setSelectedRaceId(null);
      return;
    }
    if (!selectedRaceId || !dayRaces.some((r) => r.id === selectedRaceId)) {
      setSelectedRaceId(dayRaces[0].id);
    }
  }, [dayRaces, selectedRaceId]);

  const race = useMemo(() => {
    return dayRaces.find((r) => r.id === selectedRaceId) ?? null;
  }, [dayRaces, selectedRaceId]);

  // Drafts / input state
  const [drafts, setDrafts] = useState({}); // raceId -> draft

  // ✅ IMPORTANT: helper MUST be defined before the useEffect that uses it
  const toDraftFromStoredResult = (stored) => {
    const base = {
      eachWayFraction: "", // UI no longer controls EW fraction
      placements: {
        1: { horseName: "", oddsInput: "" },
        2: { horseName: "", oddsInput: "" },
        3: { horseName: "", oddsInput: "" },
        4: { horseName: "", oddsInput: "" },
        5: { horseName: "", oddsInput: "" },
        6: { horseName: "", oddsInput: "" },
        7: { horseName: "", oddsInput: "" },
        8: { horseName: "", oddsInput: "" },
      },

      // ✅ NEW (persisted in results doc)
      favouriteHorseName: "",
      nonRunnerHorseNames: [], // store as NAMES in draft for UI friendliness
    };

    // Old schema: stored is a string (winner only)
    if (typeof stored === "string") {
      base.placements[1] = { horseName: stored, oddsInput: "" };
      return base;
    }

    // New schema: placements array
    const placementsArr = Array.isArray(stored?.placements) ? stored.placements : [];
    for (const p of placementsArr) {
      const pos = Number(p?.position);
      if (!pos || pos < 1 || pos > 8) continue;

      base.placements[pos] = {
        horseName: String(p?.horseName ?? ""),
        oddsInput: String(p?.oddsDisplay ?? ""),
      };
    }

    // ✅ NEW: prefill favourite + nonrunners from stored result (if present)
    base.favouriteHorseName = String(stored?.favouriteHorseName ?? "");
    base.nonRunnerHorseNames = Array.isArray(stored?.nonRunnerHorseNames)
      ? stored.nonRunnerHorseNames.map((x) => String(x))
      : [];

    return base;
  };

  // ✅ Prefill draft from stored results ONCE per race (no clobber while editing)
  useEffect(() => {
    if (!race?.id) return;
    if (drafts?.[race.id]) return;

    const stored = results?.[race.id];
    const initial = toDraftFromStoredResult(stored);
    setDrafts((prev) => ({ ...prev, [race.id]: initial }));
  }, [race?.id, results, drafts]);

  // ✅ horseList hook MUST NOT be below a conditional return
  const horseList = useMemo(() => {
    if (!race) return [];
    if (Array.isArray(race.horses) && race.horses.length) return race.horses;
    if (Array.isArray(race.runners) && race.runners.length) {
      return race.runners.map((r) => r?.horseName).filter(Boolean);
    }
    return [];
  }, [race]);

  // ✅ NEW: derive EW fraction directly from the race
  const raceEachWayFraction = useMemo(() => {
    const n = Number(race?.eachWayFraction);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_EW_FRACTION;
  }, [race?.eachWayFraction]);

  // ✅ NEW: how many places to show (drives how many rows appear)
  const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

  const placesCount = useMemo(() => {
    const fromRace = Number(race?.placesPaid);
    const fromResult = Number(results?.[race?.id]?.placesPaid);

    const n =
      (Number.isFinite(fromRace) && fromRace > 0 ? fromRace : null) ??
      (Number.isFinite(fromResult) && fromResult > 0 ? fromResult : null) ??
      DEFAULT_PLACES_PAID;

    return clamp(n, 1, 8);
  }, [race?.id, race?.placesPaid, results]);

  // Guard: no races at all
  if (!races || races.length === 0) {
    return (
      <View style={styles.container}>
        <View style={styles.content}>
          <Text style={styles.title}>Admin: Enter Results</Text>
          <Text style={styles.subtitle}>
            No races available for the active competition.
          </Text>

          <Pressable style={[styles.button, styles.buttonPrimary]} onPress={onBack}>
            <Text style={styles.buttonText}>Back</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  // Guard: no race found for selected day
  if (!race) {
    return (
      <View style={styles.container}>
        <View style={styles.content}>
          <Text style={styles.title}>Admin: Enter Results</Text>
          <Text style={styles.subtitle}>
            No races found for this day. Try selecting another day.
          </Text>

          {!!days.length && (
            <View style={{ flexDirection: "row", gap: 10, marginVertical: 10 }}>
              {days.filter(isISODate).map((d) => {
                const active = d === selectedDay;
                return (
                  <Pressable
                    key={d}
                    onPress={() => setSelectedDay(d)}
                    style={[styles.smallChoice, active && styles.cardActive, { flex: 1 }]}
                  >
                    <Text style={styles.smallChoiceText}>{formatDayLabel(d)}</Text>
                  </Pressable>
                );
              })}
            </View>
          )}

          <Pressable style={styles.button} onPress={onBack}>
            <Text style={styles.buttonText}>Back</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  // --------- everything below here is NOT hooks ---------

  const updateDraft = (raceId, updater) => {
    setDrafts((prev) => {
      const curr =
        prev[raceId] ?? {
          eachWayFraction: DEFAULT_EW_FRACTION,
          placements: {
            1: { horseName: "", oddsInput: "" },
            2: { horseName: "", oddsInput: "" },
            3: { horseName: "", oddsInput: "" },
            4: { horseName: "", oddsInput: "" },
            5: { horseName: "", oddsInput: "" },
            6: { horseName: "", oddsInput: "" },
            7: { horseName: "", oddsInput: "" },
            8: { horseName: "", oddsInput: "" },
          },

          // ✅ NEW
          favouriteHorseName: "",
          nonRunnerHorseNames: [],
        };

      const next = updater(curr);
      return { ...prev, [raceId]: next };
    });
  };

  const setPlaceHorse = (pos, horseName) => {
    updateDraft(race.id, (curr) => {
      const nextPlacements = { ...curr.placements };

      // prevent the same horse being used twice
      for (let i = 1; i <= 8; i++) {
        if (i !== pos && nextPlacements[i]?.horseName === horseName) {
          nextPlacements[i] = { ...nextPlacements[i], horseName: "" };
        }
      }

      nextPlacements[pos] = { ...(nextPlacements[pos] ?? {}), horseName };
      return { ...curr, placements: nextPlacements };
    });
  };

  const setPlaceOdds = (pos, oddsInput) => {
    updateDraft(race.id, (curr) => {
      const nextPlacements = { ...curr.placements };
      nextPlacements[pos] = { ...(nextPlacements[pos] ?? {}), oddsInput };
      return { ...curr, placements: nextPlacements };
    });
  };

  // ✅ NEW: Favourite + Non-runners setters (store names in draft)
  const setFavouriteHorseName = (horseName) => {
    updateDraft(race.id, (curr) => ({ ...curr, favouriteHorseName: horseName }));
  };

  const toggleNonRunnerHorseName = (horseName) => {
    updateDraft(race.id, (curr) => {
      const set = new Set(curr.nonRunnerHorseNames ?? []);
      if (set.has(horseName)) set.delete(horseName);
      else set.add(horseName);
      return { ...curr, nonRunnerHorseNames: Array.from(set) };
    });
  };

  const draft =
    drafts[race.id] ?? {
      eachWayFraction: DEFAULT_EW_FRACTION,
      placements: {
        1: { horseName: "", oddsInput: "" },
        2: { horseName: "", oddsInput: "" },
        3: { horseName: "", oddsInput: "" },
        4: { horseName: "", oddsInput: "" },
        5: { horseName: "", oddsInput: "" },
        6: { horseName: "", oddsInput: "" },
        7: { horseName: "", oddsInput: "" },
        8: { horseName: "", oddsInput: "" },
      },

      // ✅ NEW
      favouriteHorseName: "",
      nonRunnerHorseNames: [],
    };

  const saveResult = () => {
    const p1 = draft.placements[1];
    if (!p1?.horseName) {
      showMessage("Missing winner", "Please set the 1st place horse.");
      return;
    }

    const positionsToUse = Array.from({ length: placesCount }, (_, i) => i + 1);

    // ✅ Build horseName -> horseId map from race.runners (preferred)
    const nameToId = new Map(
      (race.runners ?? [])
        .filter((r) => r?.horseName && r?.horseId)
        .map((r) => [String(r.horseName).trim(), String(r.horseId).trim()])
    );

    // ✅ Build placements[] with horseId INCLUDED
    const placements = positionsToUse
      .map((pos) => {
        const p = draft.placements[pos];
        if (!p?.horseName) return null;

        const horseName = String(p.horseName).trim();
        const horseId = nameToId.get(horseName) || null;

        // Odds: must be valid to include this placement
        const oddsDecimal = fractionalToDecimal(p.oddsInput);
        if (!oddsDecimal || oddsDecimal <= 1) return null;

        return {
          position: pos,
          horseName,
          horseId,
          oddsDecimal,
          oddsDisplay: String(p.oddsInput ?? "").trim(),
        };
      })
      .filter(Boolean);

    if (placements.length === 0) {
      showMessage("Missing odds", "Enter odds for at least the winner.");
      return;
    }

    // ✅ Convert placements[] -> finishPositions map (horseId => position)
    const finishPositions = {};
    for (const p of placements) {
      if (p?.horseId) finishPositions[p.horseId] = Number(p.position);
    }

    // ✅ NEW: favourite + nonrunners mapped to IDs for the Cloud Function
    const favouriteHorseName = String(draft.favouriteHorseName ?? "").trim();
    const favouriteHorseId = favouriteHorseName ? (nameToId.get(favouriteHorseName) || null) : null;

    const nonRunnerHorseNames = Array.isArray(draft.nonRunnerHorseNames)
      ? draft.nonRunnerHorseNames.map((x) => String(x).trim()).filter(Boolean)
      : [];

    const nonRunners = nonRunnerHorseNames
      .map((nm) => nameToId.get(nm))
      .filter(Boolean);

    // Optional UI safety: favourite cannot also be a non-runner
    const safeNonRunners = favouriteHorseId
      ? nonRunners.filter((id) => id !== favouriteHorseId)
      : nonRunners;

    onSaveResult(race.id, {
      competitionId: activeCompetitionId,
      finishPositions,

      placesPaid: placesCount,
      eachWayFraction: raceEachWayFraction,
      placements,

      winnerHorse: placements.find((p) => p.position === 1)?.horseName ?? p1.horseName,

      // ✅ NEW fields written into results/{raceId}
      favouriteHorseId: favouriteHorseId || null,
      favouriteHorseName: favouriteHorseName || "",
      nonRunners: safeNonRunners,                 // array of horseIds
      nonRunnerHorseNames: nonRunnerHorseNames,   // (optional, helps admin UI readability)
    });
  };

  const isNonRunner = (horseName) =>
    (draft.nonRunnerHorseNames ?? []).includes(horseName);

  return (
    <View style={styles.container}>
      <ScrollView
        style={styles.content}
        contentContainerStyle={{ paddingBottom: FOOTER_HEIGHT + 40 }}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.card}>
          <Text style={styles.h2}>Current active competition</Text>
          <Text style={styles.cardTitle}>
            {activeCompetition?.name ? activeCompetition.name : "No active competition set"}
          </Text>
          <Text style={styles.cardHint}>
            To change the active competition, go back to the Select Competition screen.
          </Text>
        </View>

        {/* Day toggle */}
        {!!days.length && (
          <View style={{ flexDirection: "row", gap: 10, marginVertical: 10 }}>
            {days.filter(isISODate).map((d) => {
              const active = d === selectedDay;
              return (
                <Pressable
                  key={d}
                  onPress={() => setSelectedDay(d)}
                  style={[styles.smallChoice, active && styles.cardActive, { flex: 1 }]}
                >
                  <Text style={styles.smallChoiceText}>{formatDayLabel(d)}</Text>
                </Pressable>
              );
            })}
          </View>
        )}

        <Text style={styles.title}>Admin: Enter Results</Text>

        {/* Race selector */}
        <View style={styles.raceSelectorRow}>
          {dayRaces.slice(0, 7).map((r, idx) => {
            const active = r.id === selectedRaceId;
            return (
              <Pressable
                key={r.id}
                onPress={() => setSelectedRaceId(r.id)}
                style={[
                  styles.raceSelectorBtn,
                  active && styles.raceSelectorBtnActive,
                  { flex: 1 },
                ]}
              >
                <Text
                  style={[
                    styles.raceSelectorText,
                    active && styles.raceSelectorTextActive,
                  ]}
                >
                  {idx + 1}
                </Text>
              </Pressable>
            );
          })}
        </View>

        <View style={styles.card}>
          <Text style={styles.h2}>Selected race</Text>
          <Text style={styles.cardTitle}>{race.name}</Text>
          <Text style={styles.cardHint}>{race.date}</Text>
        </View>

        {/* ✅ NEW: Favourite + Non-runners */}
        <View style={[styles.card, styles.cardAlt, { marginTop: 12 }]}>
          <Text style={styles.h2}>Non-runners & favourite</Text>
          <Text style={styles.cardHint}>
            If a user tips a non-runner, they will be settled as the favourite (tip docs are not changed).
          </Text>

          {/* Favourite picker */}
          <View style={{ marginTop: 12, gap: 8 }}>
            <Text style={styles.sectionTitle}>Favourite (for NR swap)</Text>
            <View style={styles.pickerWrap}>
              <Picker
                style={styles.picker}
                itemStyle={styles.pickerItem}
                selectedValue={draft.favouriteHorseName}
                onValueChange={(val) => setFavouriteHorseName(val)}
                dropdownIconColor={THEME.text2 ?? "#666"}
              >
                <Picker.Item label="Select favourite…" value="" />
                {horseList.map((h) => (
                  <Picker.Item key={`${race.id}_fav_${h}`} label={h} value={h} />
                ))}
              </Picker>
            </View>
          </View>

          {/* Non-runners list */}
          <View style={{ marginTop: 14, gap: 8 }}>
            <Text style={styles.sectionTitle}>Mark non-runners</Text>

            {horseList.length === 0 ? (
              <Text style={styles.cardHint}>No horses found for this race.</Text>
            ) : (
              <View style={{ gap: 8 }}>
                {horseList.map((h) => {
                  const active = isNonRunner(h);
                  const isFav = draft.favouriteHorseName === h;

                  return (
                    <Pressable
                      key={`${race.id}_nr_${h}`}
                      onPress={() => {
                        if (isFav) {
                          showMessage("Can't mark favourite as NR", "Choose a different favourite first.");
                          return;
                        }
                        toggleNonRunnerHorseName(h);
                      }}
                      style={[
                        styles.smallChoice,
                        active && styles.cardActive,
                        isFav && { opacity: 0.5 },
                      ]}
                    >
                      <Text style={styles.smallChoiceText}>
                        {active ? "✅ " : ""}{h}{isFav ? " (Favourite)" : ""}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            )}
          </View>
        </View>

        {/* Places editor */}
        <View style={[styles.card, styles.cardAlt, { marginTop: 12 }]}>
          <Text style={styles.h2}>Enter finishing order</Text>
          <Text style={styles.cardHint}>
            This race pays {placesCount} place{placesCount === 1 ? "" : "s"}.
          </Text>

          <View style={{ marginTop: 10, gap: 12 }}>
            {Array.from({ length: placesCount }, (_, i) => i + 1).map((pos) => {
              const place = draft.placements?.[pos] ?? { horseName: "", oddsInput: "" };

              const posLabel =
                pos === 1 ? "1st" :
                pos === 2 ? "2nd" :
                pos === 3 ? "3rd" :
                `${pos}th`;

              return (
                <View key={`${race.id}_place_${pos}`} style={{ gap: 8 }}>
                  <Text style={styles.sectionTitle}>{posLabel}</Text>

                  <View style={{ flexDirection: "row", gap: 10, alignItems: "center" }}>
                    {/* Dropdown */}
                    <View style={styles.pickerWrap}>
                      <Picker
                        style={styles.picker}
                        itemStyle={styles.pickerItem}
                        selectedValue={place.horseName}
                        onValueChange={(val) => setPlaceHorse(pos, val)}
                        dropdownIconColor={THEME.text2 ?? "#666"}
                      >
                        <Picker.Item label="Select horse…" value="" />
                        {horseList.map((h) => (
                          <Picker.Item
                            key={`${race.id}_${pos}_${h}`}
                            label={isNonRunner(h) ? `${h} (NR)` : h}
                            value={h}
                          />
                        ))}
                      </Picker>
                    </View>

                    {/* Odds */}
                    <View style={{ flex: 1 }}>
                      <TextInput
                        placeholder="Odds (5/1)"
                        placeholderTextColor={THEME.text3}
                        value={place.oddsInput}
                        onChangeText={(t) => setPlaceOdds(pos, t)}
                        style={styles.input}
                      />
                    </View>
                  </View>
                </View>
              );
            })}
          </View>
        </View>

        {/* Save */}
        <Pressable
          style={[styles.button, styles.buttonPrimary, { marginTop: 14 }]}
          onPress={saveResult}
        >
          <Text style={styles.buttonText}>Save result</Text>
        </Pressable>

        <Pressable style={styles.button} onPress={onClearResults}>
          <Text style={styles.buttonText}>Clear ALL results</Text>
        </Pressable>

        <Pressable style={styles.button} onPress={onBack}>
          <Text style={styles.buttonText}>Back</Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}

const THEME = {
  // Light, warm background (no harsh white)
  bg: "#FAF7F2",
  surface: "#FFFFFF",
  surface2: "#F3EEE6",

  // Soft borders
  border: "rgba(20, 20, 20, 0.08)",

  // Dark text for light UI
  text: "#111827",                 // near-black
  text2: "rgba(17, 24, 39, 0.72)",
  text3: "rgba(17, 24, 39, 0.52)",

  // Pastel accents
  primary: "#F4A261",              // pastel orange
  success: "#84DCC6",              // pastel green/teal
  warning: "#F6C177",              // soft amber
  danger: "#F28B82",               // soft red

  r12: 12,
  r16: 16,
  r20: 20,
};

const WEB_SHADOW = {
  sm: { boxShadow: "0 1px 6px rgba(17,24,39,0.10)" },
  md: { boxShadow: "0 8px 22px rgba(17,24,39,0.12)" },
  lg: { boxShadow: "0 14px 32px rgba(17,24,39,0.14)" },
};

const shadow = (level = "md") => (Platform.OS === "web" ? WEB_SHADOW[level] : null);

const SHADOW = Platform.select({
  ios: {
    shadowColor: "#000",
    shadowOpacity: 0.10,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
  },
  android: {
    elevation: 4,
  },
  web: {
    // RN Web accepts this style key in many setups.
    // If yours complains, see “Web fallback” below.
    boxShadow: "0px 8px 22px rgba(0,0,0,0.12)",
  },
});

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: THEME.bg,
    alignItems: "center",
    justifyContent: "flex-start",
    paddingVertical: 16, // slightly tighter in light UI
  },

  content: {
    width: "100%",
    maxWidth: 520,
    paddingHorizontal: 16,
  },

  topBar: {
    width: "100%",
    backgroundColor: "rgba(255,255,255,0.92)",
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: THEME.border,
  },

  footerBar: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    height: FOOTER_HEIGHT,
    backgroundColor: "rgba(255,255,255,0.94)",
    borderTopWidth: 1,
    borderTopColor: THEME.border,
  },

  // Footer is "double the width" of header inner (520 -> 1040)
  footerInner: {
    width: "100%",
    maxWidth: 520, // ✅ match content + header
    alignSelf: "center",
    height: "100%",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-evenly",
    paddingHorizontal: 6,
  },

  footerBtn: {
    flex: 1,
    flexBasis: 0, // ✅ ensures equal widths on all devices
    minWidth: 0,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 8, // ✅ reduces height pressure
    paddingHorizontal: 2, // ✅ prevents text from touching edges
    borderRadius: 14,
  },

  footerBtnActive: {
    backgroundColor: "rgba(244,162,97,0.25)", // THEME.primary with alpha
    borderWidth: 1,
    borderColor: "rgba(244,162,97,0.35)",
  },

  footerIcon: {
    fontSize: 18,
  },

  footerText: {
    marginTop: 3,
    fontSize: 11, // ✅ helps "Leaderboard" fit
    fontWeight: "900",
    color: THEME.text,
    textAlign: "center", // ✅ better when squeezed
  },

  footerTextActive: {
    textDecorationLine: "underline",
  },

  topBarInner: {
    width: "100%",
    maxWidth: 520,
    paddingHorizontal: 16,
    alignSelf: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },

  topBarBtn: {
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 12,
    backgroundColor: "rgba(255,255,255,0.45)",
    borderWidth: 1,
    borderColor: "rgba(0,0,0,0.10)",
  },

  topBarBtnText: {
    fontSize: 14,
    fontWeight: "800",
    color: "#111",
  },

  topBarProfileIcon: {
    fontSize: 16,
    fontWeight: "800",
    color: "#111",
  },

  title: {
    fontSize: 26,
    fontWeight: "800",
    marginBottom: 6,
    textAlign: "center",
    paddingHorizontal: 66,
    color: THEME.text,
  },

  subtitle: {
    fontSize: 16,
    marginBottom: 12,
    textAlign: "center",
    paddingHorizontal: 56,
    color: THEME.text2,
  },

  sectionTitle: {
    fontSize: 16,
    fontWeight: "800",
    marginTop: 10,
    color: THEME.text,
  },

  statsRow: { flexDirection: "row", gap: 10, marginBottom: 14 },

  statCard: {
    flex: 1,
    backgroundColor: THEME.surface,
    borderRadius: THEME.r16,
    padding: 14,
    alignItems: "center",
    borderWidth: 1,
    borderColor: THEME.border,
  },
  statNumber: { fontSize: 22, fontWeight: "900", color: THEME.text },
  statLabel: { marginTop: 4, color: THEME.text3 },

  carouselWrap: {
    marginTop: 2,
    marginBottom: 14,
  },

  carouselSlide: {
    backgroundColor: THEME.surface,
    borderRadius: THEME.r16,
    padding: 16,
    borderWidth: 1,
    borderColor: THEME.border,
  },

  carouselKicker: {
    fontSize: 12,
    fontWeight: "800",
    color: THEME.text3,
    marginBottom: 6,
  },

  carouselTitle: {
    fontSize: 16,
    fontWeight: "900",
    color: THEME.text,
    marginBottom: 6,
  },

  carouselBody: {
    color: THEME.text2,
    marginTop: 2,
  },

  carouselDots: {
    flexDirection: "row",
    justifyContent: "center",
    gap: 8,
    marginTop: 8,
  },

  carouselDot: {
    width: 8,
    height: 8,
    borderRadius: 999,
    backgroundColor: "rgba(17,24,39,0.18)",
  },

  carouselDotActive: {
    backgroundColor: "rgba(17,24,39,0.45)",
  },

  htmlCard: {
    marginBottom: 14,
  },

  htmlHeaderRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 8,
  },

  htmlInput: {
    borderWidth: 1,
    borderColor: THEME.border,
    backgroundColor: "rgba(17,24,39,0.03)",
    borderRadius: 14,
    padding: 12,
    minHeight: 120,
    color: THEME.text,
    textAlignVertical: "top",
  },

  input: {
    borderWidth: 1,
    borderColor: THEME.border,
    backgroundColor: "rgba(17,24,39,0.03)",
    borderRadius: 14,
    padding: 12,
    marginBottom: 10,
    color: THEME.text,
  },

  button: {
    borderRadius: THEME.r16,
    paddingVertical: 12,
    paddingHorizontal: 16,
    alignItems: "center",
    marginBottom: 10,
    backgroundColor: THEME.surface,
    borderWidth: 1,
    borderColor: THEME.border,
  },

  buttonPrimary: {
    backgroundColor: THEME.primary, // pastel orange
    borderColor: "rgba(0,0,0,0.06)",
  },

  buttonGhost: {
    backgroundColor: "rgba(255,255,255,0.04)",
    borderColor: "rgba(255,255,255,0.10)",
  },

  buttonDanger: {
    backgroundColor: "rgba(239,68,68,0.18)",
    borderColor: "rgba(239,68,68,0.35)",
  },

  adminButton: { marginTop: 6 },

  smallButton: {
    alignSelf: "flex-start",
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 14,
  },

  buttonDisabled: {
    opacity: 0.45,
  },

  buttonText: {
    fontSize: 16,
    fontWeight: "800",
    color: THEME.text,
  },

  buttonTextEmail: {
    fontSize: 16,
    fontWeight: "800",
    textAlign: "center",
    color: THEME.text,
  },
  
  card: {
    backgroundColor: THEME.surface,
    borderRadius: THEME.r16,
    padding: 14,
    marginBottom: 10,

    // depth
    shadowColor: "#000",
    shadowOpacity: 0.35,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 6,
  },

  // optional: slightly different surface for nested cards (Results screen uses nested cards)
  cardAlt: {
    backgroundColor: THEME.surface2,
  },

  heroWrap: {
  marginTop: 8,
  marginBottom: 14,
  borderRadius: THEME.r16,
  overflow: "hidden", // ✅ clip to rounded corners (like screenshot)
},
heroBg: {
  width: "100%",
  // ❌ no height: "100%"
  // ❌ no minHeight: "100vh"
},

  heroBgImage: {
    transform: [{ scale: 1.02 }],
  },

  heroOverlay: {
  paddingTop: 26,
  paddingHorizontal: 16,
  paddingBottom: 100,  // ✅ this makes the hero image extend downward
  alignItems: "center",
},

  heroCard: {
  width: "100%",
  maxWidth: 440,
  backgroundColor: "rgba(255,255,255,0.92)",
  borderRadius: 16,
  paddingTop: 28,
  paddingHorizontal: 18,
  paddingBottom: 16,
  alignItems: "center",
},
  heroBadge: {
  width: 40,
  height: 40,
  borderRadius: 999,
  backgroundColor: "#0F6B4F",
  alignItems: "center",
  justifyContent: "center",
  position: "absolute",
  top: -20, // ✅ sits above the card like screenshot
},
  heroBadgeIcon: {
    fontSize: 16,
    color: "#fff",
  },
  heroKicker: {
    fontSize: 12,
    letterSpacing: 0.6,
    color: "#111",
    opacity: 0.9,
    textAlign: "center",
    marginBottom: 4,
  },
  heroHeadline: {
    fontSize: 36,
    fontWeight: "900",
    color: "#f59f00",
    textAlign: "center",
    marginBottom: 6,
  },
  heroSub: {
    fontSize: 13,
    color: "#111",
    opacity: 0.85,
    textAlign: "center",
    marginBottom: 12,
  },
  heroCta: {
    alignSelf: "stretch",
    justifyContent: "center",
    alignItems: "center",
    paddingVertical: 12,
    borderRadius: 14,
    backgroundColor: "#0f6b4f",
    borderWidth: 1,
    borderColor: "rgba(0,0,0,0.10)",
    overflow: "hidden",

    // depth
    shadowColor: "#000",
    shadowOpacity: 0.22,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 6 },
    elevation: 6,
  },
  heroCtaText: {
    fontSize: 14,
    fontWeight: "900",
    textAlign: "center",
    letterSpacing: 0.8,
    color: "#fff",
  },
  heroCtaSheen: {
    position: "absolute",
    top: -20,
    bottom: -20,
    width: 60,
    backgroundColor: "rgba(255,255,255,0.28)",
  },

  cardActive: {
    // selected = slightly brighter border + extra depth
    borderWidth: 1,
    borderColor: "rgba(59,130,246,0.55)",
    shadowOpacity: 0.5,
    shadowRadius: 16,
    elevation: 8,
  },

  meSummaryCard: {
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.10)",
  },

  leaderboardMe: {
    borderWidth: 1,
    borderColor: "rgba(59,130,246,0.55)",
    backgroundColor: "rgba(59,130,246,0.12)",
  },

  cardTitle: {
    fontSize: 16,
    fontWeight: "800",
    color: THEME.text,
  },

  cardSubtitle: {
    marginTop: 4,
    color: THEME.text2,
  },

  cardHint: {
    marginTop: 6,
    color: THEME.text3,
    fontSize: 12,
  },

  smallChoice: {
    backgroundColor: "rgba(255,255,255,0.05)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.10)",
    borderRadius: 14,
    paddingVertical: 10,
    paddingHorizontal: 12,
    alignItems: "center",
    justifyContent: "center",
  },

  smallChoiceText: {
    fontSize: 14,
    fontWeight: "800",
    color: THEME.text,
    textAlign: "center",
  },

  cardSection: { marginTop: 12 },

  raceSelectorRow: {
    flexDirection: "row",
    width: "100%",
    gap: 8, // spacing between buttons
    marginVertical: 10,
  },

  raceSelectorBtn: {
    flex: 1,
    marginHorizontal: 4,
    height: 44,
    borderRadius: 14,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "rgba(255,255,255,0.05)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.10)",
  },

  raceSelectorBtnActive: {
    backgroundColor: "rgba(59,130,246,0.20)",
    borderColor: "rgba(59,130,246,0.55)",
  },

  raceSelectorBtnTipped: {
    backgroundColor: "rgba(34,197,94,0.22)",
    borderColor: "rgba(34,197,94,0.60)",
  },

  raceSelectorText: { fontSize: 16, fontWeight: "800", color: THEME.text2 },

  raceSelectorTextActive: { color: THEME.text, fontWeight: "900" },
  raceSelectorTextTipped: { color: THEME.text, fontWeight: "900" },

  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "space-between",
    marginTop: 16,
    alignContent: "flex-start",
  },

  adminWideButton: {
    width: "100%",
    borderRadius: THEME.r16,
    paddingVertical: 12,
    alignItems: "center",
    marginBottom: 12,
    backgroundColor: "rgba(17,24,39,0.03)",
    borderWidth: 1,
    borderColor: THEME.border,
  },

  adminWideButtonText: {
    fontSize: 16,
    fontWeight: "800",
    color: THEME.text,
  },

  profileCornerButton: {
    position: "absolute",
    top: 12,
    padding: 10,
    borderRadius: 999,
    zIndex: 9999,
    elevation: 10,

    backgroundColor: THEME.surface,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.12)",

    shadowColor: "#000",
    shadowOpacity: 0.45,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 7 },
  },
  profileCornerButtonText: {
    color: THEME.text,
    fontSize: 16,
    fontWeight: "800",
  },

  authScrollContent: {
  flexGrow: 1,
  justifyContent: "center",
  alignItems: "center",
},

  authHeroBg: {
  flex: 1,
  minHeight: "100vh",      // ✅ web full height
  width: "100%",
},

  authCard: {
  paddingBottom: 16,
  position: "relative", // allows badge to anchor to the card
},

  authBadge: {
  position: "absolute",
  top: -20,
  left: "50%",
  transform: [{ translateX: -20 }],

  width: 40,
  height: 40,
  borderRadius: 20,

  backgroundColor: THEME.primary,
  alignItems: "center",
  justifyContent: "center",
  zIndex: 2,
},

  authTitle: {
    fontSize: 22,
    fontWeight: "900",
    color: THEME.text,
    textAlign: "center",
    marginBottom: 6,
  },

  authSubtitle: {
    fontSize: 14,
    color: THEME.text2,
    textAlign: "center",
    marginBottom: 12,
  },

  authForm: {
    alignSelf: "stretch",
    marginTop: 6,
  },

  authSecondaryBtn: {
    backgroundColor: "rgba(17,24,39,0.06)",
    borderColor: "rgba(17,24,39,0.10)",
  },

  authHint: {
    marginTop: 6,
    fontSize: 12,
    color: THEME.text3,
    textAlign: "center",
  },

  topBarAdminBtn: {
    backgroundColor: "rgba(244,162,97,0.25)", // theme primary tint
    borderColor: "rgba(244,162,97,0.45)",
  },

  topBarAdminText: {
    fontSize: 13,
    fontWeight: "900",
    letterSpacing: 1,
    color: THEME.text,
  },

  leaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 14,
  },

  leaderCenter: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingHorizontal: 10,
  },
  leaderTrophy: {
    fontSize: 16,
  },

  leaderName: {
    fontSize: 16,
    fontWeight: "900",
    color: THEME.text,
    textAlign: "center",
  },

  leaderInsetLeft: {
    minWidth: 38,
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 12,
    backgroundColor: "rgba(17,24,39,0.06)",
    borderWidth: 1,
    borderColor: "rgba(17,24,39,0.08)",
    alignItems: "center",
  },

  leaderInsetRight: {
    minWidth: 52,
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 12,
    backgroundColor: "rgba(17,24,39,0.06)",
    borderWidth: 1,
    borderColor: "rgba(17,24,39,0.08)",
    alignItems: "center",
  },

  leaderInsetText: {
    fontSize: 12,
    fontWeight: "900",
    color: THEME.text,
  },

  /** #1 SPECIAL EFFECT **/
  leaderboardTop: {
    borderWidth: 1,
    borderColor: "rgba(245,159,0,0.55)",
    backgroundColor: "rgba(245,159,0,0.10)",
    shadowColor: "#000",
    shadowOpacity: 0.18,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 8 },
    elevation: 7,
  },

  leaderInsetTop: {
    backgroundColor: "rgba(245,159,0,0.14)",
    borderColor: "rgba(245,159,0,0.45)",
  },

  leaderInsetTextTop: {
    color: "#b45309", // warm gold/brown
  },

  leaderNameTop: {
    color: "#b45309",
  },

  // Upcoming Races: expandable runners
  raceCardHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
  },
  raceExpandBtn: {
    width: 44,
    height: 44,
    borderRadius: 14,
    backgroundColor: "rgba(17,24,39,0.06)",
    borderWidth: 1,
    borderColor: "rgba(17,24,39,0.08)",
    alignItems: "center",
    justifyContent: "center",
  },
  raceExpandIcon: {
    fontSize: 18,
    fontWeight: "900",
    color: THEME.text,
  },

  sortRow: {
    flexDirection: "row",
    gap: 10,
    marginTop: 10,
  },
  sortPill: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 999,
    alignItems: "center",
    backgroundColor: "rgba(17,24,39,0.06)",
    borderWidth: 1,
    borderColor: "rgba(17,24,39,0.08)",
  },
  sortPillActive: {
    backgroundColor: "rgba(17,24,39,0.12)",
  },
  sortPillText: {
    fontSize: 12,
    fontWeight: "800",
    color: THEME.text2,
  },
  sortPillTextActive: {
    color: THEME.text,
  },

  runnerCard: {
    paddingVertical: 12,
  },
  runnerCardLocked: {
    opacity: 0.6,
  },
  runnerCardSelected: {
    backgroundColor: "rgba(34,197,94,0.14)",
    borderColor: "rgba(34,197,94,0.55)",
  },
  runnerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  runnerInsetLeft: {
    minWidth: 52,
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 12,
    backgroundColor: "rgba(17,24,39,0.06)",
    borderWidth: 1,
    borderColor: "rgba(17,24,39,0.08)",
    alignItems: "center",
  },
  runnerInsetRight: {
    minWidth: 86,
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 12,
    backgroundColor: "rgba(17,24,39,0.06)",
    borderWidth: 1,
    borderColor: "rgba(17,24,39,0.08)",
    alignItems: "center",
  },
  runnerInsetText: {
    fontSize: 12,
    fontWeight: "900",
    color: THEME.text,
  },

  tipUserRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "rgba(0,0,0,0.06)",
  },

  tipUserRowMissing: {
    borderColor: "rgba(220, 38, 38, 0.35)",
    backgroundColor: "rgba(220, 38, 38, 0.06)",
  },

  tipUserName: {
    flex: 1,
    marginRight: 10,
    fontWeight: "700",
  },

  tipUserPick: {
    flexShrink: 1,
    fontWeight: "600",
  },

  tipUserPickMissing: {
    fontWeight: "700",
  },

  // Admin competitions UI
  rowButton: {
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: THEME.border,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginTop: 10,
  },
  rowButtonActive: {
    borderColor: THEME.text,
  },
  rowTitle: {
    fontSize: 15,
    fontWeight: "900",
    color: THEME.text,
  },
  rowSub: {
    marginTop: 4,
    fontSize: 12,
    color: THEME.text2,
  },
  pill: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: THEME.border,
    color: THEME.text,
    fontSize: 12,
    fontWeight: "900",
  },
  pillActive: {
    borderColor: THEME.text,
  },
  valueText: {
    marginTop: 6,
    fontSize: 13,
    color: THEME.text,
    opacity: 0.9,
  },
  chipRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginTop: 8,
  },
  chip: {
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: THEME.border,
    backgroundColor: THEME.surface,
  },
  chipActive: {
    borderColor: THEME.primary,
    backgroundColor: "rgba(244,162,97,0.20)",
  },

  adminError: {
    backgroundColor: "rgba(239,68,68,0.12)",
    borderWidth: 1,
    borderColor: "rgba(239,68,68,0.35)",
    padding: 12,
    borderRadius: 12,
    color: THEME.text,
    fontWeight: "800",
    marginTop: 10,
  },

  adminCompRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: THEME.border,
  },

  muted: {
    color: THEME.text3,
    textAlign: "center",
    paddingVertical: 12,
  },

  h2: {
    fontSize: 18,
    fontWeight: "900",
    color: THEME.text,
    marginBottom: 8,
  },

  label: {
    fontSize: 13,
    fontWeight: "800",
    color: THEME.text2,
    marginBottom: 6,
  },

  pillRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginTop: 6,
  },

  dayPill: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: THEME.border,
    backgroundColor: THEME.surface,
  },

  dayPillActive: {
    borderColor: THEME.primary,
    backgroundColor: "rgba(244,162,97,0.20)",
  },

  dayPillText: {
    fontSize: 12,
    fontWeight: "900",
    color: THEME.text2,
  },

  dayPillTextActive: {
    color: THEME.text,
  },

  runnerCenter: {
    flex: 1,
    paddingHorizontal: 10,
    justifyContent: "center",
  },

  runnerName: {
    fontSize: 15,
    fontWeight: "900",
    color: THEME.text,
    textAlign: "left",
  },

  runnerMeta: {
    alignItems: "flex-end", // ✅ right aligned
    justifyContent: "center",
    gap: 2,
    maxWidth: 40, // keeps it from crushing the horse name
  },

  runnerMetaLine: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },

  runnerMetaIcon: {
    fontSize: 9,
    fontWeight: "900",
    color: THEME.text2,
  },

  runnerMetaText: {
    fontSize: 12,
    color: THEME.text2,
    flexShrink: 1,
  },

  runnerMetaRow: {
    flexDirection: "column", // ✅ stack J above T
    alignItems: "flex-start",
    marginTop: 2,
    gap: 4, // smaller vertical gap
  },

  metaGroup: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    flexShrink: 1,
  },

  runnerMetaLineSingle: {
    marginTop: 2,
    fontSize: 10,
    fontWeight: "700",
    color: THEME.text2,
    textAlign: "left",
  },

  statHeading: {
    fontSize: 12,
    fontWeight: "600",
    color: "#6b7280", // subtle grey
    marginBottom: 4,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },

  entrantRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },

  pickerWrap: {
    flex: 2,
    borderRadius: 12,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: THEME.border ?? "#ddd",
    backgroundColor: THEME.card ?? "#fff",
  },

  picker: {
    height: 44,
    width: "100%",
    color: THEME.text1 ?? "#111",
  },

  pickerItem: {
    fontSize: 16,
  },

  hotTipsBox: {
    marginTop: 12,
    padding: 14,
    borderRadius: 46,
    backgroundColor: "rgba(244,162,97,0.12)",
    borderWidth: 10,
    borderColor: "rgba(244,162,97,0.22)",
  },

  hotTipsTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },

  hotTipsTitle: {
    marginTop: 4,
    fontSize: 12,
    fontWeight: "900",
    color: THEME.text,
  },

  hotTipsHorse: {
    marginTop: 6,
    fontSize: 14,
    fontWeight: "900",
    color: THEME.text,
    textAlign: "center",
  },

  hotTipsMeta: {
    marginTop: 2,
    fontSize: 11,
    fontWeight: "700",
    color: THEME.text2,
  },

  headerWithHotTips: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 12,
  },

  hotTipsSquare: {
    width: 150,
    height: 120,
    padding: 5,
    borderRadius: 16,

    backgroundColor: "rgba(244,162,97,0.12)",
    borderWidth: 1,
    borderColor: "rgba(244,162,97,0.22)",

    alignItems: "center",
    justifyContent: "center",
  },

  stickyRaceSelectorWrap: {
    backgroundColor: THEME.bg, // important so it doesn’t look transparent while stuck
    paddingTop: 8,
    paddingBottom: 10,
    zIndex: 10,
  },

  segmentWrap: {
    gap: 10,
    marginVertical: 10,
  },

  segmentRow: {
    flexDirection: "row",
    gap: 10,
  },

  segmentInner: {
    flexDirection: "row",
    backgroundColor: "#F1F3F8", // soft neutral like My Tips
    borderRadius: 999,
    padding: 4,
    width: "92%",
    maxWidth: 520,
  },

  segmentItem: {
    flex: 1, // equal-width segments
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
  },

  segmentItemActive: {
    backgroundColor: "#FFFFFF",
    shadowColor: "#000",
    shadowOpacity: 0.08,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },

  segmentItemText: {
    fontSize: 13,
    fontWeight: "700",
    color: "#6B7280", // muted inactive text
  },

  segmentItemTextActive: {
    color: "#111827", // strong active text
  },

  overallChoice: {
    width: "100%",
    alignItems: "center",
  },

  dayChoice: {
    flex: 1, // evenly spreads dates across the row
  },

  placementRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
  },

  placementText: {
    flex: 1,
  },

  tipsPill: {
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderRadius: 999,
    backgroundColor: "rgba(0,0,0,0.06)",
    borderWidth: 1,
    borderColor: "rgba(0,0,0,0.08)",
  },

  tipsPillText: {
    fontSize: 12,
    fontWeight: "600",
    color: "rgba(0,0,0,0.70)",
  },

  dayTabText: {
    textAlign: "center",
    lineHeight: 16,
    flexShrink: 1,
  },

  rankCardContent: {
    alignItems: "center",
    justifyContent: "center",
  },

  rankCardTitle: {
    fontSize: 13,
    letterSpacing: 0.4,
    color: THEME.text2,
    marginBottom: 6,
  },

  rankCardPosition: {
    fontSize: 22,
    fontWeight: "700",
    color: THEME.text1,
  },

  rankCardOf: {
    fontSize: 16,
    fontWeight: "500",
    color: THEME.text2,
  },

  rankCardAmount: {
    marginTop: 6,
    fontSize: 15,
    fontWeight: "600",
    color: THEME.text2,
  },

  metaGroup: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    flexShrink: 1,
  },

  metaBadge: {
    fontSize: 10,
    fontWeight: "700",
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
    backgroundColor: "rgba(0,0,0,0.06)",
    color: THEME.text2,
    overflow: "hidden",
  },

  runnerMetaText: {
    fontSize: 12,
    color: THEME.text2,
    flexShrink: 1,
  },

  raceHeaderTopRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    marginBottom: 6,
  },

  mostTippedInline: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 12,
    backgroundColor: "rgba(255, 170, 0, 0.12)",
    borderWidth: 1,
    borderColor: "rgba(255, 170, 0, 0.25)",
    maxWidth: 210,
  },

  mostTippedInlineText: {
    fontSize: 12,
    color: THEME.text2,
    fontWeight: "600",
    flexShrink: 1,
  },

  mostTippedInlineHorse: {
    color: THEME.text1,
    fontWeight: "800",
  },

  mostTippedInlineUnder: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 12,
    backgroundColor: "rgba(255, 170, 0, 0.12)",
    borderWidth: 1,
    borderColor: "rgba(255, 170, 0, 0.25)",
    marginTop: 8,
    marginBottom: 8, // gives breathing room before "Tips close in"
    alignSelf: "flex-start", // keeps it neatly under the date, not stretched
  },

  runnerRowTop: {
    flexDirection: "row",
    alignItems: "flex-start",
  },

  runnerInsetLeftTop: {
    alignSelf: "flex-start",
    marginTop: 2,
  },

  runnerMain: {
    flex: 1,
    paddingLeft: 10,
  },

  runnerMetaUnderNumber: {
    marginTop: 4,
    marginLeft: -10,
  },

  runnerRightCol: {
    alignItems: "flex-end",
    gap: 6,
    minWidth: 80,
  },

  pickCtaPill: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 12,
    backgroundColor: "rgba(0,0,0,0.06)",
    borderWidth: 1,
    borderColor: "rgba(0,0,0,0.08)",
  },

  pickCtaText: {
    fontSize: 12,
    fontWeight: "800",
    color: THEME.text1,
  },

  runnerMetaFullRow: {
    marginTop: 4,
  },

  // ✅ Pull meta left so it lines up with the left edge of the number inset
  // If it’s slightly off, adjust this number to match your runnerInsetLeft width + gap.
  runnerMetaFullRow: {
    flexDirection: "row",
    marginTop: 4,
  },

  // IMPORTANT: set this to match your number inset column width + the gap to runnerMain
  // Start with 54–60, tweak once if needed.
  runnerMetaLeftSpacer: {
    width: 56,
  },

  runnerMetaContent: {
    flex: 1,
  },

  runnerMetaStack: {
    marginTop: 4,
  },

  runnerRowNew: {
    flexDirection: "row",
    alignItems: "flex-start",
  },

  runnerLeftStack: {
    alignItems: "center",
    gap: 8,
  },

  pickUnderNumberPill: {
    width: 60,
    paddingVertical: 6,
    borderRadius: 12,
    backgroundColor: "rgba(0,0,0,0.06)",
    borderWidth: 1,
    borderColor: "rgba(0,0,0,0.08)",
    alignItems: "center",
    justifyContent: "center",
  },

  pickUnderNumberText: {
    fontSize: 12,
    fontWeight: "800",
    color: THEME.text1,
  },

  oddsTallBox: {
    alignSelf: "stretch",
    minWidth: 72,
    borderRadius: 14,
    backgroundColor: "rgba(0,0,0,0.06)",
    borderWidth: 1,
    borderColor: "rgba(0,0,0,0.08)",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 10,
  },

  runnerInsetLeftUnified: {
    width: 60,
    height: 36,
    borderRadius: 12,
    backgroundColor: "rgba(0,0,0,0.06)",
    borderWidth: 1,
    borderColor: "rgba(0,0,0,0.08)",
    alignItems: "center",
    justifyContent: "center",
  },

  // -------------------------------------------------------------------
  // ✅ NEW (added): Auth “previous iteration” look styles
  // Use these in AuthScreen:
  // styles.authScreen, authBg, authBgOverlay, authCardWrap, authLockBadge,
  // authCardContainer, authCardTitle, authCardSubtitle, authInput, authBtn, etc.
  // -------------------------------------------------------------------
  authScreen: {
    flex: 1,
    backgroundColor: THEME.bg,
  },
  authBg: {
  flex: 1,
  width: "100%",
  minHeight: "100vh",
  backgroundColor: "#e9dad0a1", // slightly darker than card
  justifyContent: "center",
  alignItems: "center",
},
  authBgOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.25)",
  },
  authCardWrapNew: {
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 16,
    paddingVertical: 24,
  },
  authLockBadgeNew: {
    position: "absolute",
    top: -14,
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: THEME.primary,
    alignItems: "center",
    justifyContent: "center",
    zIndex: 10,
    shadowColor: "#000",
    shadowOpacity: 0.2,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  authLockBadgeTextNew: { fontSize: 16 },
  authCardContainerNew: {
    width: "100%",
    maxWidth: 520,
    backgroundColor: "rgba(255,255,255,0.92)",
    borderRadius: 18,
    paddingHorizontal: 18,
    paddingTop: 26,
    paddingBottom: 18,
    shadowColor: "#000",
    shadowOpacity: 0.18,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 6 },
    elevation: 6,
  },
  authCardTitleNew: {
    fontSize: 20,
    fontWeight: "800",
    textAlign: "center",
    marginBottom: 8,
    color: "#1A1A1A",
  },
  authCardSubtitleNew: {
    fontSize: 13,
    textAlign: "center",
    marginBottom: 16,
    color: "#555",
    lineHeight: 18,
  },
  authInputNew: {
    height: 46,
    borderRadius: 12,
    paddingHorizontal: 14,
    backgroundColor: "#EAF2FF",
    borderWidth: 1,
    borderColor: "#D6E4FF",
    marginBottom: 12,
    fontSize: 15,
    color: "#111",
  },
  authBtnNew: {
    height: 48,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#EFEFEF",
    marginTop: 10,
    borderWidth: 1,
    borderColor: "rgba(0,0,0,0.08)",
  },
  authBtnPrimaryNew: {
    backgroundColor: THEME.primary,
    borderColor: "rgba(0,0,0,0.08)",
  },
  authBtnTextNew: {
    fontSize: 15,
    fontWeight: "800",
    color: "#222",
  },
  authBtnTextPrimaryNew: {
    color: "#111",
  },
  authPrivacyTextNew: {
    fontSize: 11,
    color: "#666",
    marginTop: 14,
    lineHeight: 15,
    textAlign: "center",
  },

landingPrizeCard: {
  backgroundColor: "rgba(255,255,255,0.92)",
  shadowColor: "#000",
  shadowOpacity: 0.12,
  shadowRadius: 18,
  shadowOffset: { width: 0, height: 10 },
  elevation: 6,
  alignItems: "center",
},

landingKicker: {
  marginTop: 8,
  fontSize: 12,
  letterSpacing: 0.6,
  fontWeight: "700",
  color: "#3E3E3E",
  textAlign: "center",
},

landingAmount: {
  marginTop: 6,
  fontSize: 34,
  fontWeight: "900",
  color: "#F59A00", // orange
  textAlign: "center",
},

landingSub: {
  marginTop: 8,
  fontSize: 12,
  color: "#4B5563",
  textAlign: "center",
},

landingCta: {
  marginTop: 12,
  width: "100%",
  borderRadius: 16,
  paddingVertical: 14,
  backgroundColor: "#0B6B4D",
  alignItems: "center",
  justifyContent: "center",
  overflow: "hidden",
},

landingCtaText: {
  fontSize: 14,
  fontWeight: "800",
  color: "#FFFFFF",
  letterSpacing: 0.4,
},

landingHeader: {
  alignItems: "center",
  gap: 8,
},

landingBadgePinned: {
  position: "absolute",
  top: -18,
  alignSelf: "center",
  width: 36,
  height: 36,
  borderRadius: 18,
  backgroundColor: "#0B6B4D", // green badge
  alignItems: "center",
  justifyContent: "center",
  shadowColor: "#000",
  shadowOpacity: 0.12,
  shadowRadius: 10,
  shadowOffset: { width: 0, height: 6 },
  elevation: 4,
},

landingBadgeIcon: {
  fontSize: 18,
},

landingAmounts: {
  alignItems: "center",
  marginBottom: 10,
},

landingHeroWrap: {
  width: "100%",
  borderRadius: 18,
  overflow: "hidden",
  aspectRatio: 16 / 10, // ✅ responsive height
  marginBottom: 14,
},

landingHeroImage: {
  justifyContent: "flex-start",
},

displayNameAlert: {
  marginHorizontal: 16,
  marginTop: 10,
  marginBottom: 6,
  paddingVertical: 14,
  paddingHorizontal: 16,
  borderRadius: 12,
  backgroundColor: "#FFF3CD",
  borderWidth: 1,
  borderColor: "#FFC107",
  alignItems: "center",
},

displayNameAlertText: {
  fontSize: 15,
  fontWeight: "600",
  color: "#856404",
  textAlign: "center",
},

displayNameAlertLink: {
  marginTop: 4,
  fontSize: 14,
  fontWeight: "700",
  color: "#D97706",
},

rulesButton: {
  marginTop: 10,
  marginBottom: 6,
  marginHorizontal: 16,
  backgroundColor: "#ffffff",
  borderRadius: 14,
  borderWidth: 1,
  borderColor: THEME.line,
  paddingVertical: 14,
  paddingHorizontal: 16,
  alignItems: "center",
},

rulesButtonText: {
  fontSize: 16,
  fontWeight: "700",
  color: THEME.text,
},

rulestext: {
  fontSize: "12",
  fontWeight: "500",

}

});
