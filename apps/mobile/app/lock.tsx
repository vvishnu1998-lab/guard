/**
 * Auto-lock screen — shown after 5 min inactivity (Section 7)
 * Guard must re-authenticate with biometric or PIN to resume.
 * Cannot be dismissed by swiping — full-screen takeover.
 */
import { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Alert } from 'react-native';
import { useAuthStore } from '../store/authStore';
import { Colors, Spacing, Radius, Fonts } from '../constants/theme';

export default function LockScreen() {
  const [loading, setLoading] = useState(false);
  const { unlock, logout } = useAuthStore();

  async function handleUnlock() {
    setLoading(true);
    try {
      await unlock('');
    } catch {
      Alert.alert('Authentication Failed', 'Could not verify your identity. Try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <View style={styles.container}>
      <Text style={styles.logo}>GUARD</Text>
      <Text style={styles.title}>SESSION LOCKED</Text>
      <Text style={styles.subtitle}>
        Your session was locked due to inactivity.{'\n'}
        Verify your identity to continue.
      </Text>

      <View style={styles.lockIcon}>
        <Text style={styles.lockEmoji}>🔒</Text>
      </View>

      <TouchableOpacity
        style={[styles.button, loading && styles.disabled]}
        onPress={handleUnlock}
        disabled={loading}
      >
        <Text style={styles.buttonText}>
          {loading ? 'VERIFYING...' : 'UNLOCK WITH FACE ID / PIN'}
        </Text>
      </TouchableOpacity>

      <TouchableOpacity onPress={logout} style={styles.logoutLink}>
        <Text style={styles.logoutText}>Sign out instead</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1, backgroundColor: Colors.structure,
    justifyContent: 'center', alignItems: 'center', padding: Spacing.xl,
  },
  logo:     { fontFamily: Fonts.heading, fontSize: 32, color: Colors.action, letterSpacing: 8, marginBottom: Spacing.xs },
  title:    { fontFamily: Fonts.heading, fontSize: 24, color: Colors.base, letterSpacing: 3, marginBottom: Spacing.sm },
  subtitle: { color: Colors.muted, textAlign: 'center', fontSize: 14, lineHeight: 22, marginBottom: Spacing.xxl },
  lockIcon: { marginBottom: Spacing.xxl },
  lockEmoji:{ fontSize: 64 },
  button: {
    width: '100%', backgroundColor: Colors.action,
    borderRadius: Radius.md, padding: Spacing.md, alignItems: 'center',
  },
  disabled:   { opacity: 0.5 },
  buttonText: { fontFamily: Fonts.heading, color: Colors.structure, fontSize: 17, letterSpacing: 2 },
  logoutLink: { marginTop: Spacing.xl },
  logoutText: { color: Colors.muted, fontSize: 13 },
});
