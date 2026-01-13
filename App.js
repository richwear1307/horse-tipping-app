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
  getDoc,
  getDocs,
  serverTimestamp,
} from "firebase/firestore";

function showMessage(title, message) {
  if (Platform.OS === "web") alert(`${title}\n\n${message}`);
  else Alert.alert(title, message);
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
        <Text>Loading…</Text>
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
useEffect(() => {
  if (!user) return;

const q = query(
  collection(firestoreDb, "tips"),
  where("userId", "==", user.uid),
  orderBy("createdAt", "desc")
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
      <RacesScreen
        races={races}
        onBack={() => setScreen("home")}
        onOpenRace={(raceId) => {
          setSelectedRaceId(raceId);
          setScreen("raceDetails");
        }}
      />
    );
  }

if (screen === "profile") {
  return (
    <ProfileScreen
      user={user}
      onBack={() => setScreen("home")}
    />
  );
}

if (screen === "raceDetails" && selectedRace) {
  return (
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
  );
}


if (screen === "myTips") {
  return (
    <MyTipsScreen
      tips={tips}
      tipsLoading={tipsLoading}
      results={results}
      onBack={() => setScreen("home")}
      onClear={() => { /* optional: delete tips later */ }}
    />
  );
}

if (screen === "admin") {
  if (!isAdmin) {
    showMessage("Access denied", "Admin only");
    setScreen("home");
    return null;
  }

  return (
    <AdminScreen
      races={races}
      results={results}
      onBack={() => setScreen("home")}
      onSetWinner={async (raceId, winnerHorse) => {
        try {
          await setDoc(doc(firestoreDb, "results", raceId), {
            raceId,
            winnerHorse,
            updatedAt: serverTimestamp(),
          });

          const race = races.find((r) => r.id === raceId);
          showMessage(
            "Winner saved ✅",
            `${race?.name}\nWinner: ${winnerHorse}`
          );
        } catch (e) {
          showMessage("Error saving result", e.message);
        }
      }}
    />
  );
}

if (screen === "leaderboard") {
  return (
    <LeaderboardScreen
      currentUserId={user.uid}
      onBack={() => setScreen("home")}
      results={results}
    />
  );
}


  return (
    <HomeScreen
      userEmail={user.email}
      totalTips={totalTips}
      points={gbpTotal}
      onGoProfile={() => setScreen("profile")}
      onGoRaces={() => setScreen("races")}
      onGoMyTips={() => setScreen("myTips")}
      onGoAdmin={isAdmin ? () => setScreen("admin") : null}
      onGoLeaderboard={() => setScreen("leaderboard")}
      onLogout={() => signOut(auth)}
    />
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
        value={email}
        onChangeText={setEmail}
        autoCapitalize="none"
        style={styles.input}
      />
      <TextInput
        placeholder="Password (6+ chars)"
        value={password}
        onChangeText={setPassword}
        secureTextEntry
        style={styles.input}
      />

      <Pressable style={styles.button} onPress={login}>
        <Text style={styles.buttonText}>Log In</Text>
      </Pressable>

      <Pressable style={styles.button} onPress={register}>
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
  onGoProfile,
  onGoRaces,
  onGoMyTips,
  onGoAdmin,
  onGoLeaderboard,
  onLogout,
}) {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>🏇 Horse Racing Tips Game</Text>
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

      {/* 3x3 grid buttons */}
      <View style={styles.grid}>
        {onGoProfile && (
          <Pressable style={styles.gridButton} onPress={onGoProfile}>
            <Text style={styles.gridButtonText}>Profile</Text>
          </Pressable>
        )}

        <Pressable style={styles.gridButton} onPress={onGoRaces}>
          <Text style={styles.gridButtonText}>Races</Text>
        </Pressable>

        <Pressable style={styles.gridButton} onPress={onGoMyTips}>
          <Text style={styles.gridButtonText}>My Tips</Text>
        </Pressable>

        <Pressable style={styles.gridButton} onPress={onGoLeaderboard}>
          <Text style={styles.gridButtonText}>Leaderboard</Text>
        </Pressable>

        {onGoAdmin && (
          <Pressable style={styles.gridButton} onPress={onGoAdmin}>
            <Text style={styles.gridButtonText}>Admin</Text>
          </Pressable>
        )}

        <Pressable style={styles.gridButton} onPress={onLogout}>
          <Text style={styles.gridButtonText}>Log Out</Text>
        </Pressable>
      </View>

      <StatusBar style="auto" />
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
      <Text style={styles.title}>Profile</Text>

      <Pressable style={[styles.button, styles.smallButton]} onPress={onBack}>
        <Text style={styles.buttonText}>← Back</Text>
      </Pressable>

      {loading ? (
        <Text style={styles.subtitle}>Loading profile…</Text>
      ) : (
        <>
          <Text style={styles.subtitle}>Display name (shown on leaderboard)</Text>

          <TextInput
            value={displayName}
            onChangeText={setDisplayName}
            placeholder="Enter display name"
            style={styles.input}
          />

          <Pressable
            style={[styles.button, saving ? styles.buttonDisabled : null]}
            onPress={save}
            disabled={saving}
          >
            <Text style={styles.buttonText}>{saving ? "Saving…" : "Save"}</Text>
          </Pressable>
        </>
      )}

      <StatusBar style="auto" />
    </View>
  );
}

function RacesScreen({ races, onBack, onOpenRace }) {
  const [now, setNow] = useState(Date.now());
  const [selectedIndex, setSelectedIndex] = useState(0);

  // Update once per minute
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60000);
    return () => clearInterval(id);
  }, []);

  // Keep index valid
  useEffect(() => {
    if (selectedIndex > races.length - 1) {
      setSelectedIndex(0);
    }
  }, [races.length, selectedIndex]);

  const selectedRace = races[selectedIndex];

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
      <Text style={styles.title}>Upcoming Races</Text>

      <Pressable style={[styles.button, styles.smallButton]} onPress={onBack}>
        <Text style={styles.buttonText}>← Back</Text>
      </Pressable>

      {/* 1–7 race selector */}
      <View style={styles.raceSelectorRow}>
        {races.slice(0, 7).map((race, idx) => {
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
  );
}

function RaceDetailsScreen({ race, onBack, onSubmitTip }) {
  const [selectedHorse, setSelectedHorse] = useState(null);

  return (
    <View style={styles.container}>
      <Text style={styles.title}>{race.name}</Text>
      <Text style={styles.subtitle}>{race.date}</Text>

      <Pressable style={[styles.button, styles.smallButton]} onPress={onBack}>
        <Text style={styles.buttonText}>← Back</Text>
      </Pressable>

      <Text style={styles.sectionTitle}>Choose your winning horse</Text>

      <FlatList
        data={race.horses}
        keyExtractor={(h) => h}
        style={{ alignSelf: "stretch", marginTop: 10 }}
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
          styles.button,
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
  );
}

function MyTipsScreen({ tips, tipsLoading, results, onBack, onClear }) {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>My Tips</Text>

      <Pressable style={[styles.button, styles.smallButton]} onPress={onBack}>
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
          style={{ alignSelf: "stretch", marginTop: 10 }}
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
        style={[styles.button, { marginTop: 10 }]}
        onPress={onClear}
      >
        <Text style={styles.buttonText}>Clear Tips (test)</Text>
      </Pressable>
    )}

    <StatusBar style="auto" />
  </View>
);
}

function LeaderboardScreen({ currentUserId, onBack, results }) {
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

        for (const t of tips) {
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
  }, [results, usersMap]);

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
      <Text style={styles.title}>🏆 Leaderboard</Text>

      <Pressable style={[styles.button, styles.smallButton]} onPress={onBack}>
        <Text style={styles.buttonText}>← Back</Text>
      </Pressable>

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
              style={{ alignSelf: "stretch", marginTop: 10 }}
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
  );
}
function AdminScreen({ races, results, onBack, onSetWinner, onClearResults }) {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Admin: Enter Results</Text>
      <Text style={styles.subtitle}>Tap a horse to set the winner.</Text>

      <Pressable style={[styles.button, styles.smallButton]} onPress={onBack}>
        <Text style={styles.buttonText}>← Back</Text>
      </Pressable>

      <FlatList
        data={races}
        keyExtractor={(r) => r.id}
        style={{ alignSelf: "stretch", marginTop: 10 }}
        renderItem={({ item: race }) => (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>{race.name}</Text>
            <Text style={styles.cardSubtitle}>{race.date}</Text>
            <Text style={styles.cardHint}>
              Current winner: {getWinnerHorse(results[race.id]) ?? "not set"}
            </Text>

            <View style={{ marginTop: 10, gap: 8 }}>
              {race.horses.map((h) => (
                <Pressable
                  key={h}
                  style={styles.smallChoice}
                  onPress={() => onSetWinner(race.id, h)}
                >
                  <Text style={styles.smallChoiceText}>{h}</Text>
                </Pressable>
              ))}
            </View>
          </View>
        )}
      />

      <Pressable style={[styles.button, { marginTop: 10 }]} onPress={onClearResults}>
        <Text style={styles.buttonText}>Clear Results (test)</Text>
      </Pressable>

      <StatusBar style="auto" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 24, backgroundColor: "#fff", justifyContent: "center" },
  title: { fontSize: 26, fontWeight: "700", marginBottom: 6, textAlign: "center" },
  subtitle: { fontSize: 16, opacity: 0.75, marginBottom: 12, textAlign: "center" },
  sectionTitle: { fontSize: 16, fontWeight: "700", marginTop: 10 },
  statsRow: { flexDirection: "row", gap: 10, marginBottom: 14 },
  statCard: { flex: 1, borderWidth: 1, borderRadius: 12, padding: 12, alignItems: "center" },
  statNumber: { fontSize: 22, fontWeight: "800" },
  statLabel: { marginTop: 4, opacity: 0.7 },
  input: { borderWidth: 1, borderRadius: 10, padding: 12, marginBottom: 10 },
  button: { paddingVertical: 12, paddingHorizontal: 18, borderRadius: 10, borderWidth: 1, alignItems: "center", marginBottom: 10 },
  adminButton: { marginTop: 6 },
  smallButton: { alignSelf: "flex-start", paddingVertical: 8, paddingHorizontal: 12 },
  buttonDisabled: { opacity: 0.4 },
  buttonText: { fontSize: 16, fontWeight: "600" },
  card: { borderWidth: 1, borderRadius: 12, padding: 12, marginBottom: 10 },
  cardActive: { borderWidth: 2 },
  meSummaryCard: { borderWidth: 2 },
  leaderboardMe: { borderWidth: 2, backgroundColor: "#f5faff" },
  cardTitle: { fontSize: 16, fontWeight: "700" },
  cardSubtitle: { marginTop: 4, opacity: 0.7 },
  cardHint: { marginTop: 6, opacity: 0.6, fontSize: 12 },
  smallChoice: { borderWidth: 1, borderRadius: 10, paddingVertical: 10, paddingHorizontal: 12 },
  smallChoiceText: { fontSize: 14, fontWeight: "600" },
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
  borderWidth: 1,
  borderRadius: 10,
  justifyContent: "center",
  alignItems: "center",
},

raceSelectorBtnActive: {
  borderWidth: 2,
},

raceSelectorText: {
  fontSize: 16,
  fontWeight: "600",
},

raceSelectorTextActive: {
  fontWeight: "800",
},
grid: {
  flexDirection: "row",
  flexWrap: "wrap",
  justifyContent: "space-between",
  marginTop: 16,
  alignContent: "flex-start",
},

gridButton: {
  width: "30%",          // still 3 columns
  height: 110,           // ✅ control height (instead of aspectRatio)
  borderWidth: 1,
  borderRadius: 12,
  justifyContent: "center",
  alignItems: "center",
  marginBottom: 12,
  paddingHorizontal: 8,
},

gridButtonText: {
  textAlign: "center",
  fontSize: 14,
  fontWeight: "600",
},

});
