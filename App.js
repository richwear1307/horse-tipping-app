import { StatusBar } from "expo-status-bar";
import React, { useEffect, useMemo, useState } from "react";
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
  useWindowDimensions
} from "react-native";

import { auth, db as firestoreDb } from "./firebaseConfig";
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
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
  getDoc,
  getDocs,
  serverTimestamp,
} from "firebase/firestore";

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
      <Text style={styles.profileCornerButtonText}>👤</Text>
    </Pressable>
  );
}

const ADMIN_EMAIL = "richwear1307@gmail.com";

// GBP scoring defaults
const STAKE_GBP = 1;              // £1 per tip
const DEFAULT_PLACES_PAID = 3;     // top 3 count as "placed"
const DEFAULT_EW_FRACTION = 0.25;  // 1/4 odds
function formatCountdownHM(ms) {
  if (ms <= 0) return "Locked 🔒";

  const totalMinutes = Math.floor(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
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

function getRaceDays(races) {
  return [...new Set(races.map(r => r.date))].sort();
}

function getActiveRaceDay(races) {
  if (!races || races.length === 0) return null;

  const days = getRaceDays(races);
  const now = new Date();
  const today = now.toLocaleDateString("en-CA"); // YYYY-MM-DD in local timezone
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

  const entry = raceResult.placements?.find((p) => p.horseName === tip.horseName);
  if (!entry) return 0;

  const odds = Number(entry.oddsDecimal);
  if (!odds || odds <= 1) return 0;

  const winProfit = stake * (odds - 1);

  if (entry.position === 1) return winProfit;

  if (entry.position > 1 && entry.position <= placesPaid) {
    return winProfit * eachWayFraction;
  }

  return 0;
}

export default function App() {
  // ✅ Auth hooks ALWAYS run (never conditional)
  const [user, setUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);

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

  // ✅ All game hooks live in GameApp (separate component)
  return <GameApp user={user} />;
}

function GameApp({ user }) {
  // ✅ Game hooks ALWAYS run within GameApp
  const isAdmin = user.email === ADMIN_EMAIL;
  const [screen, setScreen] = useState("home"); // home | races | raceDetails | myTips | admin | leaderboard | profile
  const [selectedRaceId, setSelectedRaceId] = useState(null);
  const [tips, setTips] = useState([]);
  const [tipsLoading, setTipsLoading] = useState(true);
  const [results, setResults] = useState({}); // local results for now
  const races = useMemo(
    () => [
      {
        id: "race-1",
        name: "Kempton 14:30",
        date: "2026-01-13",
        lockAt: new Date("2026-01-13T14:25:00Z").getTime(), // lock 2 min before
        horses: ["Red Comet", "Blue Derby", "Night Runner", "Golden Gale"],
      },
      {
        id: "race-2",
        name: "Cheltenham 15:05",
        date: "2026-01-13",
        lockAt: new Date("2026-01-13T14:25:00Z").getTime(), // lock 2 min before
        horses: ["Silver Arrow", "Misty Ridge", "King’s Honour", "River Jet"],
      },
    ],
    []
  );
  
  const [nowTick, setNowTick] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), 60000); // re-evaluate daily lock each minute
    return () => clearInterval(id);
  }, []);
  const activeDay = useMemo(() => getActiveRaceDay(races), [races, nowTick]);

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
    (snap) => {
      if (snap.exists()) return;

      setDoc(ref, {
        displayName: "",
        email: user.email ?? "",
        createdAt: serverTimestamp(),
      }).catch((e) => showMessage("Profile create failed", e.message));
    },
    (err) => showMessage("Profile read failed", err.message)
  );

  return unsubscribe;
}, [user]);


  const selectedRace = races.find((r) => r.id === selectedRaceId) || null;

const gbpTotal = useMemo(() => {
  let total = 0;
  for (const tip of tips) {
    total += calcGbpProfitForTip(tip, results[tip.raceId], STAKE_GBP);
  }
  return total;
}, [tips, results]);

  const totalTips = tips.length;

if (screen === "races") {
  return (
    <View style={{ flex: 1 }}>
      <RacesScreen
        races={races}
        activeDay={activeDay}
        onBack={() => setScreen("home")}
        onOpenRace={(raceId) => {
          setSelectedRaceId(raceId);
          setScreen("raceDetails");
        }}
      />
      <ProfileCornerButton onPress={() => setScreen("profile")} />
    </View>
  );
}

if (screen === "profile") {
  return (
    <View style={{ flex: 1 }}>
      <ProfileScreen user={user} onBack={() => setScreen("home")} />
      <ProfileCornerButton onPress={() => setScreen("profile")} />
    </View>
  );
}

if (screen === "results") {
  return (
    <View style={{ flex: 1 }}>
      <ResultsScreen
        races={races}
        results={results}
        onBack={() => setScreen("home")}
      />
      <ProfileCornerButton onPress={() => setScreen("profile")} />
    </View>
  );
}

if (screen === "raceDetails" && selectedRace) {
  return (
    <View style={{ flex: 1 }}>
      <RaceDetailsScreen
        race={selectedRace}
        onBack={() => setScreen("races")}
        onSubmitTip={async (horseName) => {
        try {
          const tipId = `${user.uid}_${selectedRace.id}`;
          const tipRef = doc(firestoreDb, "tips", tipId);

          const now = Date.now();
          const lockAt = selectedRace.lockAt ?? 0;

          // Block new tips + edits after lock time
          if (lockAt && now >= lockAt) {
            showMessage(
              "Tips closed 🔒",
              "This race is locked. You can’t submit or change your tip now."
            );
            setScreen("myTips");
            return;
          }

          // Create OR update the same document (one per user per race)
          await setDoc(
            tipRef,
            {
              userId: user.uid,
              userEmail: user.email ?? "",
              raceId: selectedRace.id,
              raceName: selectedRace.name,
              date: selectedRace.date,
              horseName,
              lockAt,
              updatedAt: now,
              createdAt: now,
            },
            { merge: true }
          );

          showMessage(
            "Tip saved ✅",
            `Race: ${selectedRace.name}\nTip: ${horseName}`
          );

          setScreen("myTips");
        } catch (e) {
          showMessage("Error saving tip", e.message);
        }
        }}
      />
      <ProfileCornerButton onPress={() => setScreen("profile")} />
    </View>
  );
}

if (screen === "myTips") {
  return (
    <View style={{ flex: 1 }}>
      <MyTipsScreen
        tips={tips}
        tipsLoading={tipsLoading}
        results={results}
        onBack={() => setScreen("home")}
        onClear={() => { /* optional */ }}
      />
      <ProfileCornerButton onPress={() => setScreen("profile")} />
    </View>
  );
}

if (screen === "admin") {
  return (
    <View style={{ flex: 1 }}>
      <AdminScreen
      races={races}
      results={results}
      onBack={() => setScreen("home")}
      onSaveResult={async (raceId, resultDoc) => {
        try {
          await setDoc(doc(firestoreDb, "results", raceId), {
            raceId,
            ...resultDoc,
            updatedAt: serverTimestamp(),
          });

          const race = races.find((r) => r.id === raceId);
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
      <ProfileCornerButton onPress={() => setScreen("profile")} />
    </View>
  );
}

if (screen === "leaderboard") {
  return (
    <View style={{ flex: 1 }}>
      <LeaderboardScreen
        currentUserId={user.uid}
        onBack={() => setScreen("home")}
        results={results}
        races={races}
        activeDay={activeDay}
      />
      <ProfileCornerButton onPress={() => setScreen("profile")} />
    </View>
  );
}


  return (
    <View style={{ flex: 1 }}>
    <HomeScreen
      userEmail={user.email}
      totalTips={totalTips}
      points={gbpTotal}
      onGoRaces={() => setScreen("races")}
      onGoMyTips={() => setScreen("myTips")}
      onGoAdmin={isAdmin ? () => setScreen("admin") : null}
      onGoLeaderboard={() => setScreen("leaderboard")}
      onGoResults={() => setScreen("results")}
      onLogout={() => signOut(auth)}
    />
    <ProfileCornerButton onPress={() => setScreen("profile")} />
  </View>
);
}

function AuthScreen() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const register = async () => {
    try {
      await createUserWithEmailAndPassword(auth, email, password);
      showMessage("Account created", "You are now logged in.");
    } catch (e) {
      showMessage("Error", e.message);
    }
  };

  const login = async () => {
    try {
      await signInWithEmailAndPassword(auth, email, password);
    } catch (e) {
      showMessage("Error", e.message);
    }
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>🏇 Horse Racing Tips</Text>
      <Text style={styles.subtitle}>Log in to play</Text>

      <TextInput
        placeholder="Email"
        placeholderTextColor="rgba(255,255,255,0.45)"
        value={email}
        onChangeText={setEmail}
        autoCapitalize="none"
        style={styles.input}
      />
      <TextInput
        placeholder="Password (6+ chars)"
        placeholderTextColor="rgba(255,255,255,0.45)"
        value={password}
        onChangeText={setPassword}
        secureTextEntry
        style={styles.input}
      />

      <Pressable style={[styles.button, styles.buttonPrimary]} onPress={login}>
        <Text style={styles.buttonText}>Log In</Text>
      </Pressable>

      <Pressable style={[styles.button, styles.buttonPrimary]} onPress={register}>
        <Text style={styles.buttonText}>Register</Text>
      </Pressable>

      <StatusBar style="auto" />
    </View>
  );
}

function HomeScreen({
  userEmail,
  totalTips,
  points,
  onGoRaces,
  onGoMyTips,
  onGoAdmin,
  onGoLeaderboard,
  onGoResults,
  onLogout,
}) {
  return (
    <View style={styles.container}>
      <View style={styles.content}>
      <Text style={styles.title}>🏇 Cheltenham Festival Tipping Game</Text>
      <Text style={styles.subtitle}>{userEmail}</Text>

      <View style={styles.statsRow}>
        <View style={styles.statCard}>
          <Text style={styles.statNumber}>{totalTips}</Text>
          <Text style={styles.statLabel}>Tips</Text>
        </View>
        <View style={styles.statCard}>
          <Text style={styles.statNumber}>{formatGBP(points)}</Text>
          <Text style={styles.statLabel}>GBP</Text>
        </View>
      </View>
      {onGoAdmin && (
  <Pressable style={styles.adminWideButton} onPress={onGoAdmin}>
    <Text style={styles.adminWideButtonText}>Admin Panel</Text>
  </Pressable>
)}    

      {/* 3x3 grid buttons */}
      <View style={styles.grid}>

        <Pressable style={styles.gridButton} onPress={onGoRaces}>
          <Text style={styles.gridButtonText}>Races</Text>
        </Pressable>

        <Pressable style={styles.gridButton} onPress={onGoMyTips}>
          <Text style={styles.gridButtonText}>My Tips</Text>
        </Pressable>

        <Pressable style={styles.gridButton} onPress={onGoLeaderboard}>
          <Text style={styles.gridButtonText}>Leaderboard</Text>
        </Pressable>

        <Pressable style={styles.gridButton} onPress={onGoResults}>
  <Text style={styles.gridButtonText}>Results</Text>
</Pressable>

        <Pressable style={styles.gridButton} onPress={onLogout}>
          <Text style={styles.gridButtonText}>Log Out</Text>
        </Pressable>
      </View>

      <StatusBar style="auto" />
    </View>
    </View>
  );
}

function ResultsScreen({ races, results, onBack }) {
  const days = useMemo(() => getRaceDays(races), [races]);

  return (
    <View style={styles.container}>
      <ScrollView style={styles.content} contentContainerStyle={{ paddingBottom: 40 }}>
        <Text style={styles.title}>🏁 Results</Text>

        <Pressable style={[styles.button, styles.smallButton, styles.buttonGhost]} onPress={onBack}>
          <Text style={styles.buttonText}>← Back</Text>
        </Pressable>

        {days.map((day) => {
          const dayRaces = races.filter(r => r.date === day);

          return (
            <View key={day} style={[styles.card, { marginTop: 10 }]}>
              <Text style={styles.cardTitle}>{day}</Text>

              {dayRaces.map((r) => {
                const res = results?.[r.id];
                const winner = res?.placements?.find(p => p.position === 1);

                return (
                  <View key={r.id} style={[styles.card, { marginTop: 8 }]}>
                    <Text style={styles.cardTitle}>{r.name}</Text>

                    {!winner ? (
                      <Text style={styles.cardSubtitle}>Result: pending</Text>
                    ) : (
                      <>
                        <Text style={styles.cardSubtitle}>
                          Winner: {winner.horseName}
                        </Text>
                        <Text style={styles.cardHint}>
                          Odds: {winner.oddsDisplay || winner.oddsDecimal}
                        </Text>
                      </>
                    )}
                  </View>
                );
              })}
            </View>
          );
        })}

        <StatusBar style="auto" />
      </ScrollView>
    </View>
  );
}

function ProfileScreen({ user, onBack }) {
  const [loading, setLoading] = useState(true);
  const [displayName, setDisplayName] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const ref = doc(firestoreDb, "users", user.uid);

    const unsub = onSnapshot(
      ref,
      (snap) => {
        const data = snap.exists() ? snap.data() : null;
        setDisplayName(data?.displayName ?? "");
        setLoading(false);
      },
      (err) => {
        setLoading(false);
        showMessage("Profile error", err.message);
      }
    );

    return unsub;
  }, [user.uid]);

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
          displayName: displayName, // EXACTLY as typed
          email: user.email ?? "",
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );

      showMessage("Saved ✅", "Your display name has been updated.");
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

      <Pressable style={[styles.button, styles.smallButton, styles.buttonGhost]} onPress={onBack}>
        <Text style={styles.buttonText}>← Back</Text>
      </Pressable>

      {loading ? (
        <Text style={styles.subtitle}>Loading profile…</Text>
      ) : (
        <>
          <Text style={styles.subtitle}>Display name (shown on leaderboard)</Text>

          <TextInput
            value={displayName}
            placeholderTextColor="rgba(255,255,255,0.45)"
            onChangeText={setDisplayName}
            placeholder="Enter display name"
            style={styles.input}
          />

          <Pressable
            style={[styles.button, styles.buttonPrimary, saving ? styles.buttonDisabled : null]}
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

function RacesScreen({ races, activeDay, onBack, onOpenRace }) {
  const [now, setNow] = useState(Date.now());
  const [selectedIndex, setSelectedIndex] = useState(0);

  // Update once per minute
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60000);
    return () => clearInterval(id);
  }, []);

  // Keep index valid

    const visibleRaces = useMemo(() => {
  if (!activeDay) return [];
  return races.filter(r => r.date === activeDay);
}, [races, activeDay]);
  useEffect(() => {
if (selectedIndex > visibleRaces.length - 1) {
  setSelectedIndex(0);
}
}, [visibleRaces.length, selectedIndex]);

  const selectedRace = visibleRaces[selectedIndex];

  if (!selectedRace) {
    return (
      <View style={styles.container}>
        <Text style={styles.title}>Upcoming Races</Text>
        <Text style={styles.subtitle}>No races available.</Text>
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
      <View style={styles.content}>
      <Text style={styles.title}>Upcoming Races</Text>

      <Pressable style={[styles.button, styles.smallButton, styles.buttonGhost]} onPress={onBack}>
        <Text style={styles.buttonText}>← Back</Text>
      </Pressable>

      {/* 1–7 race selector */}
      <View style={styles.raceSelectorRow}>
        {visibleRaces.slice(0, 7).map((race, idx) => {
          const active = idx === selectedIndex;
          return (
            <Pressable
              key={race.id}
              onPress={() => setSelectedIndex(idx)}
              style={[
                styles.raceSelectorBtn,
                active && styles.raceSelectorBtnActive,
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

      {/* Selected race card */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>{selectedRace.name}</Text>
        <Text style={styles.cardSubtitle}>{selectedRace.date}</Text>

        <Text style={styles.cardHint}>
          {locked ? "Tips closed" : "Tips close in"}: {countdownText}
        </Text>

<Pressable
  style={[
    styles.button,
    styles.buttonPrimary,
    { marginTop: 10 },
    locked && styles.buttonDisabled,
  ]}
  disabled={locked}
  onPress={() => onOpenRace(selectedRace.id)}
>
  <Text style={styles.buttonText}>
    {locked ? "Race locked" : "Open race"}
  </Text>
</Pressable>
      </View>

      <StatusBar style="auto" />
    </View>
  </View>
  );
}

function RaceDetailsScreen({ race, onBack, onSubmitTip }) {
  const [selectedHorse, setSelectedHorse] = useState(null);

  return (
    <View style={styles.container}>
      <View style={styles.content}>
      <Text style={styles.title}>{race.name}</Text>
      <Text style={styles.subtitle}>{race.date}</Text>

      <Pressable style={[styles.button, styles.smallButton, styles.buttonGhost]} onPress={onBack}>
        <Text style={styles.buttonText}>← Back</Text>
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

function MyTipsScreen({ tips, tipsLoading, results, onBack, onClear }) {
  return (
    <View style={styles.container}>
      <View style={styles.content}>
      <Text style={styles.title}>My Tips</Text>

      <Pressable style={[styles.button, styles.smallButton, styles.buttonGhost]} onPress={onBack}>
        <Text style={styles.buttonText}>← Back</Text>
      </Pressable>

      {tipsLoading ? (
        <Text style={styles.subtitle}>Loading tips…</Text>
      ) : tips.length === 0 ? (
        <Text style={styles.subtitle}>No tips yet. Submit one from Races.</Text>
      ) : (
        <FlatList
          data={tips}
          keyExtractor={(t) => t.id}
          style={{ marginTop: 10 }}
          renderItem={({ item }) => {
            const raceResult = results[item.raceId];
            const winnerHorse = getWinnerHorse(raceResult);
            const settled = !!raceResult;

            const profit = settled
              ? calcGbpProfitForTip(item, raceResult, STAKE_GBP)
              : 0;

            let outcomeText = "Result: pending";
            if (settled) {
              if (profit > 0) {
                const placement = raceResult?.placements?.find(
                  (p) => p.horseName === item.horseName
                );
                if (placement?.position === 1) {
                  outcomeText = `Result: WIN ✅ (+${formatGBP(profit)})`;
                } else {
                  outcomeText = `Result: PLACED ✅ (+${formatGBP(profit)})`;
                }
              } else {
                outcomeText = `Result: Lost (winner was ${winnerHorse ?? "unknown"})`;
              }
            }

        return (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>{item.raceName}</Text>
            <Text style={styles.cardSubtitle}>Tip: {item.horseName}</Text>
            <Text style={styles.cardHint}>{outcomeText}</Text>
          </View>
        );
      }}
    />
      )}   {/* ✅ closes the ": (" branch AND the { ... } */}

    {!!onClear && (
      <Pressable
        style={[styles.button, styles.buttonDanger, { marginTop: 10 }]}
        onPress={onClear}
      >
        <Text style={styles.buttonText}>Clear Tips (test)</Text>
      </Pressable>
    )}

    <StatusBar style="auto" />
  </View>
  </View>
);
}

function LeaderboardScreen({ currentUserId, onBack, results, races, activeDay }) {
  const [leaderboard, setLeaderboard] = useState([]);
  const [mode, setMode] = useState("day"); // "day" | "all"
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [usersMap, setUsersMap] = useState({});
  const listRef = React.useRef(null);

  // Load user profiles (for display names)
  useEffect(() => {
    const unsub = onSnapshot(
      collection(firestoreDb, "users"),
      (snapshot) => {
        const map = {};
        snapshot.docs.forEach((d) => {
          map[d.id] = d.data(); // d.id is uid
        });
        setUsersMap(map);
      },
      (err) => showMessage("Users load error", err.message)
    );

    return unsub;
  }, []);

  // Load tips + compute leaderboard
  useEffect(() => {
    const unsubscribe = onSnapshot(
      collection(firestoreDb, "tips"),
      (snapshot) => {
        const tips = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
        const byUser = {}; // userId -> { userId, displayName, gbp, tips }

const racesById = Object.fromEntries((races ?? []).map(r => [r.id, r]));

// Only count races that have taken place (i.e. have a result)
const completedTips =
  (tips ?? []).filter(t => !!results?.[t.raceId]);

// Day mode = only completed races from activeDay
const scopedTips =
  mode === "all"
    ? completedTips
    : completedTips.filter(t => {
        const race = racesById[t.raceId];
        return race && race.date === activeDay;
      });

for (const t of scopedTips) {
  const userId = t.userId || "unknown";
  const displayName =
    usersMap[userId]?.displayName || t.userEmail || userId;

  if (!byUser[userId]) {
    byUser[userId] = { userId, displayName, gbp: 0, tips: 0 };
  }

  byUser[userId].tips += 1;
  byUser[userId].gbp += calcGbpProfitForTip(t, results?.[t.raceId], STAKE_GBP);
}

        const list = Object.values(byUser).sort((a, b) => b.gbp - a.gbp);
        setRows(list);
        setLoading(false);
      },
      (err) => {
        setLoading(false);
        showMessage("Leaderboard error", err.message);
      }
    );

    return unsubscribe;
}, [results, usersMap, mode, races, activeDay]);

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

    listRef.current?.scrollToIndex({
      index: myIndex,
      animated: true,
      viewPosition: 0.3,
    });
  };

  return (
    <View style={styles.container}>
      <View style={styles.content}>
      <Text style={styles.title}>🏆 Leaderboard</Text>

      <Pressable style={[styles.button, styles.smallButton, styles.buttonGhost]} onPress={onBack}>
        <Text style={styles.buttonText}>← Back</Text>
      </Pressable>

      <View style={{ flexDirection: "row", gap: 10, marginVertical: 10 }}>
  <Pressable
    style={[styles.smallChoice, mode === "day" && styles.cardActive, { flex: 1 }]}
    onPress={() => setMode("day")}
  >
    <Text style={styles.smallChoiceText}>Today</Text>
  </Pressable>

  <Pressable
    style={[styles.smallChoice, mode === "all" && styles.cardActive, { flex: 1 }]}
    onPress={() => setMode("all")}
  >
    <Text style={styles.smallChoiceText}>Cumulative</Text>
  </Pressable>
</View>

      {loading ? (
        <Text style={styles.subtitle}>Loading leaderboard…</Text>
      ) : (
        <>
          {/* Your position summary */}
          <View style={[styles.card, styles.meSummaryCard]}>
            <Text style={styles.cardTitle}>
              Your position: {myRow ? `#${myIndex + 1} of ${rows.length}` : "—"}
            </Text>
            <Text style={styles.cardSubtitle}>
              {myRow
                ? `${formatGBP(myRow.gbp)} • ${myRow.tips} tips`
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
            <Text style={styles.subtitle}>No tips yet.</Text>
          ) : (
            <FlatList
              ref={listRef}
              data={rows}
              keyExtractor={(item) => item.userId}
              style={{ marginTop: 10 }}
              onScrollToIndexFailed={(info) => {
                setTimeout(() => {
                  listRef.current?.scrollToIndex({
                    index: info.index,
                    animated: true,
                    viewPosition: 0.3,
                  });
                }, 250);
              }}
              renderItem={({ item, index }) => {
                const isMe = item.userId === currentUserId;

                return (
                  <View style={[styles.card, isMe && styles.leaderboardMe]}>
                    <Text style={styles.cardTitle}>
                      #{index + 1} {item.displayName} {isMe ? "(You)" : ""}
                    </Text>
                    <Text style={styles.cardSubtitle}>
                      {formatGBP(item.gbp)} • {item.tips} tips
                    </Text>
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
function AdminScreen({ races, results, onBack, onSaveResult, onClearResults }) {
  const [selectedRaceId, setSelectedRaceId] = useState(races?.[0]?.id ?? null);
  const [positionMode, setPositionMode] = useState(1); // 1,2,3,4,5,6,7,8
  const [drafts, setDrafts] = useState({}); // raceId -> { placements: {1,2,3,4,5,6,7,8} }
  const POSITIONS = [1, 2, 3, 4, 5, 6, 7, 8];
  
  useEffect(() => {
    if (!selectedRaceId && races?.[0]?.id) setSelectedRaceId(races[0].id);
  }, [races, selectedRaceId]);

  const race = races.find((r) => r.id === selectedRaceId);

  const updateDraft = (raceId, updater) => {
    setDrafts((prev) => {
      const curr =
        prev[raceId] ?? {
          placesPaid: 3,
          eachWayFraction: 0.25,
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
        };

      const next = updater(curr);
      return { ...prev, [raceId]: next };
    });
  };

  if (!race) {
    return (
      <View style={styles.container}>
        <View style={styles.content}>
          <Text style={styles.title}>Admin: Enter Results</Text>
          <Text style={styles.subtitle}>No races available.</Text>
          <Pressable style={[styles.button, styles.smallButton, styles.buttonGhost]} onPress={onBack}>
            <Text style={styles.buttonText}>← Back</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  const draft =
    drafts[race.id] ?? {
      placesPaid: 3,
      eachWayFraction: 0.25,
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
    };

  const assignHorse = (horseName) => {
    updateDraft(race.id, (curr) => {
      const nextPlacements = { ...curr.placements };

      // prevent the same horse being set for multiple positions
      for (const pos of POSITIONS) {
        if (nextPlacements[pos]?.horseName === horseName) {
          nextPlacements[pos] = { ...nextPlacements[pos], horseName: "" };
        }
      }

      nextPlacements[positionMode] = {
        ...(nextPlacements[positionMode] ?? {}),
        horseName,
      };

      return { ...curr, placements: nextPlacements };
    });
  };

  const setOdds = (pos, txt) => {
    updateDraft(race.id, (curr) => {
      const nextPlacements = { ...curr.placements };
      nextPlacements[pos] = { ...(nextPlacements[pos] ?? {}), oddsInput: txt };
      return { ...curr, placements: nextPlacements };
    });
  };

  const saveResult = () => {
    const p1 = draft.placements[1];
    if (!p1?.horseName) {
      showMessage("Missing winner", "Please set the 1st place horse.");
      return;
    }

    const placements = POSITIONS
      .map((pos) => {
        const p = draft.placements[pos];
        if (!p?.horseName) return null;

        const oddsDecimal = fractionalToDecimal(p.oddsInput);
        if (!oddsDecimal || oddsDecimal <= 1) return null;

        return { position: pos, horseName: p.horseName, oddsDecimal, oddsDisplay: p.oddsInput };
      })
      .filter(Boolean);

    if (placements.length === 0) {
      showMessage("Missing odds", "Enter odds for at least the winner.");
      return;
    }

    onSaveResult(race.id, {
      placesPaid: Number(draft.placesPaid) || 3,
      eachWayFraction: Number(draft.eachWayFraction) || 0.25,
      placements,
      winnerHorse:
        placements.find((p) => p.position === 1)?.horseName ?? p1.horseName,
    });
  };

return (
  <View style={styles.container}>
    <ScrollView
      style={styles.content}
      contentContainerStyle={{ paddingBottom: 40 }}
      keyboardShouldPersistTaps="handled"
    >
      <Text style={styles.title}>Admin: Enter Results</Text>

      <Pressable style={[styles.button, styles.smallButton, styles.buttonGhost]} onPress={onBack}>
        <Text style={styles.buttonText}>← Back</Text>
      </Pressable>

      {/* Race selector 1–7 */}
      <View style={styles.raceSelectorRow}>
        {races.slice(0, 7).map((r, idx) => {
          const active = r.id === race.id;
          return (
            <Pressable
              key={r.id}
              onPress={() => setSelectedRaceId(r.id)}
              style={[
                styles.raceSelectorBtn,
                active && styles.raceSelectorBtnActive,
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
        <Text style={styles.cardTitle}>{race.name}</Text>
        <Text style={styles.cardSubtitle}>{race.date}</Text>

        <Text style={styles.cardHint}>
          Current winner: {getWinnerHorse(results[race.id]) ?? "not set"}
        </Text>

        {/* Settlement settings */}
        <Text style={[styles.sectionTitle, { marginTop: 10 }]}>Places paid</Text>
        <TextInput
          value={String(draft.placesPaid ?? 3)}
          placeholderTextColor="rgba(255,255,255,0.45)"
          onChangeText={(txt) =>
            updateDraft(race.id, (curr) => ({ ...curr, placesPaid: txt }))
          }
          keyboardType="number-pad"
          style={styles.input}
        />

        <Text style={styles.sectionTitle}>Each-way fraction (e.g. 0.25)</Text>
        <TextInput
          value={String(draft.eachWayFraction ?? 0.25)}
          placeholderTextColor="rgba(255,255,255,0.45)"
          onChangeText={(txt) =>
            updateDraft(race.id, (curr) => ({ ...curr, eachWayFraction: txt }))
          }
          keyboardType="decimal-pad"
          style={styles.input}
        />

        {/* Position mode */}
        <Text style={styles.sectionTitle}>Setting position</Text>
        <View
          style={{
            flexDirection: "row",
            flexWrap: "wrap",
            gap: 8,
            marginBottom: 10,
          }}
        >
          {POSITIONS.map((pos) => (
            <Pressable
              key={pos}
              onPress={() => setPositionMode(pos)}
              style={[
                styles.smallChoice,
                positionMode === pos && styles.cardActive,
              ]}
            >
              <Text style={styles.smallChoiceText}>
                {pos === 1
                  ? "1st"
                  : pos === 2
                  ? "2nd"
                  : pos === 3
                  ? "3rd"
                  : `${pos}th`}
              </Text>
            </Pressable>
          ))}
        </View>

        <Text style={styles.cardHint}>Tap a horse to assign it.</Text>

        {/* Horse buttons */}
        <View style={{ marginTop: 10, gap: 8 }}>
          {race.horses.map((h) => (
            <Pressable
              key={h}
              style={styles.smallChoice}
              onPress={() => assignHorse(h)}
            >
              <Text style={styles.smallChoiceText}>{h}</Text>
            </Pressable>
          ))}
        </View>

        {/* Odds inputs for 1..8 */}
        <View style={{ marginTop: 12 }}>
          {POSITIONS.map((pos) => {
            const p = draft.placements[pos];
            return (
              <View key={pos} style={{ marginBottom: 10 }}>
                <Text style={styles.cardSubtitle}>
                  {pos === 1
                    ? "Winner"
                    : `${pos}${pos === 2 ? "nd" : pos === 3 ? "rd" : "th"} place`}
                  : {p?.horseName || "—"}
                </Text>
                <TextInput
                  placeholder='Odds (decimal "6.5" or fractional "5/1")'
                  placeholderTextColor="rgba(255,255,255,0.45)"
                  value={p?.oddsInput ?? ""}
                  onChangeText={(txt) => setOdds(pos, txt)}
                  style={styles.input}
                />
              </View>
            );
          })}
        </View>

        <Pressable style={[styles.button, styles.buttonPrimary, { marginTop: 6 }]} onPress={saveResult}>
          <Text style={styles.buttonText}>Save results</Text>
        </Pressable>
      </View>

      {!!onClearResults && (
        <Pressable
          style={[styles.button, styles.buttonDanger, { marginTop: 10 }]}
          onPress={onClearResults}
        >
          <Text style={styles.buttonText}>Clear Results (test)</Text>
        </Pressable>
      )}

      <StatusBar style="auto" />
    </ScrollView>
  </View>
);
}

const THEME = {
  bg: "#0B0F14",
  surface: "#151A21",
  surface2: "#0F141B",
  border: "rgba(255,255,255,0.10)",
  text: "#FFFFFF",
  text2: "rgba(255,255,255,0.72)",
  text3: "rgba(255,255,255,0.55)",

  primary: "#3B82F6",
  success: "#22C55E",
  warning: "#F59E0B",
  danger: "#EF4444",

  r12: 12,
  r16: 16,
  r20: 20,
};

const styles = StyleSheet.create({
container: {
  flex: 1,
  backgroundColor: THEME.bg,
  alignItems: "center",
  justifyContent: "flex-start",
  paddingVertical: 24,
},

content: {
  width: "100%",
  maxWidth: 520,
  paddingHorizontal: 16,
},

title: {
  fontSize: 26,
  fontWeight: "800",
  marginBottom: 6,
  textAlign: "center",
  paddingHorizontal: 66,
  color: THEME.text,
  letterSpacing: 0.2,
},

subtitle: {
  fontSize: 16,
  marginBottom: 12,
  textAlign: "center",
  paddingHorizontal: 56,
  color: THEME.text2,
},

  sectionTitle: { fontSize: 16, fontWeight: "800", marginTop: 10, color: THEME.text },
  statsRow: { flexDirection: "row", gap: 10, marginBottom: 14 },

statCard: {
  flex: 1,
  backgroundColor: THEME.surface,
  borderRadius: THEME.r16,
  padding: 12,
  alignItems: "center",
  borderWidth: 1,
  borderColor: "rgba(255,255,255,0.08)",
},
statNumber: { fontSize: 22, fontWeight: "900", color: THEME.text },
statLabel: { marginTop: 4, color: THEME.text3 },

  input: {
  borderWidth: 1,
  borderColor: THEME.border,
  backgroundColor: "rgba(255,255,255,0.06)",
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
  backgroundColor: "rgba(255,255,255,0.06)",
  borderWidth: 1,
  borderColor: THEME.border,
},

buttonPrimary: {
  backgroundColor: THEME.primary,
  borderColor: "rgba(255,255,255,0.10)",
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
},
smallChoiceText: { fontSize: 14, fontWeight: "800", color: THEME.text },
  cardSection: { marginTop: 12 },
  raceSelectorRow: {
  flexDirection: "row",
  justifyContent: "space-between",
  alignSelf: "stretch",
  marginTop: 12,
  marginBottom: 12,
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

raceSelectorText: { fontSize: 16, fontWeight: "800", color: THEME.text2 },

raceSelectorTextActive: { color: THEME.text, fontWeight: "900" },

grid: {
  flexDirection: "row",
  flexWrap: "wrap",
  justifyContent: "space-between",
  marginTop: 16,
  alignContent: "flex-start",
},

gridButton: {
  width: "30%",
  height: 110,
  borderRadius: THEME.r16,
  justifyContent: "center",
  alignItems: "center",
  marginBottom: 12,
  paddingHorizontal: 10,

  backgroundColor: THEME.surface,
  borderWidth: 1,
  borderColor: "rgba(255,255,255,0.08)",

  shadowColor: "#000",
  shadowOpacity: 0.35,
  shadowRadius: 12,
  shadowOffset: { width: 0, height: 6 },
  elevation: 6,
},

gridButtonText: {
  textAlign: "center",
  fontSize: 14,
  fontWeight: "800",
  color: THEME.text,
},

adminWideButton: {
  width: "100%",
  borderRadius: THEME.r16,
  paddingVertical: 12,
  alignItems: "center",
  marginBottom: 12,
  backgroundColor: "rgba(255,255,255,0.06)",
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
});
