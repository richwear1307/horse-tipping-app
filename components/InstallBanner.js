import { View, Text, Pressable, StyleSheet } from "react-native";
import { useInstallPrompt } from "../hooks/useInstallPrompt";
import { useState } from "react";

export default function InstallBanner() {
  const { isInstallable, isIOS, promptInstall } = useInstallPrompt();
  const [dismissed, setDismissed] = useState(
    localStorage.getItem("installDismissed") === "true"
  );

  if (dismissed) return null;

  if (!isInstallable && !isIOS) return null;

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Install TCC Tips</Text>

      {isIOS ? (
        <Text style={styles.text}>
          Tap <Text style={styles.bold}>Share</Text> →{" "}
          <Text style={styles.bold}>Add to Home Screen</Text>
        </Text>
      ) : (
        <Pressable style={styles.button} onPress={promptInstall}>
          <Text style={styles.buttonText}>Install App</Text>
        </Pressable>
      )}

      <Pressable
        onPress={() => {
          localStorage.setItem("installDismissed", "true");
          setDismissed(true);
        }}
      >
        <Text style={styles.dismiss}>Not now</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: "#1f2937", // brand dark
    padding: 16,
    borderRadius: 14,
    margin: 12,
    shadowColor: "#000",
    shadowOpacity: 0.2,
    shadowRadius: 8,
  },
  title: {
    color: "#fff",
    fontSize: 18,
    fontWeight: "700",
    marginBottom: 6,
  },
  text: {
    color: "#e5e7eb",
    fontSize: 14,
  },
  bold: {
    fontWeight: "700",
    color: "#fff",
  },
  button: {
    backgroundColor: "#f59e0b", // brand accent
    paddingVertical: 10,
    borderRadius: 10,
    marginTop: 8,
  },
  buttonText: {
    textAlign: "center",
    fontWeight: "700",
    color: "#111827",
  },
  dismiss: {
    marginTop: 8,
    color: "#9ca3af",
    textAlign: "right",
    fontSize: 12,
  },
});
