/**
 * Auto-lock screen — shown after 5 min inactivity (Section 7)
 * Guard must re-authenticate with biometric or password to resume.
 * Cannot be dismissed by swiping — full-screen takeover.
 */
import { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Alert, TextInput } from 'react-native';
import * as LocalAuthentication from 'expo-local-authentication';
import { useAuthStore } from '../store/authStore';
import { Colors, Spacing, Radius, Fonts } from '../constants/theme';
import { apiClient } from '../lib/apiClient';

export default function LockScreen() {
  const [loading, setLoading]     = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [password, setPassword]   = useState('');
  const { unlock, logout, guardId } = useAuthStore();

  async function handleBiometric() {
    setLoading(true);
    try {
      const enrolled = await LocalAuthentication.isEnrolledAsync();
      if (!enrolled) {
        // No biometrics enrolled — go straight to password
        setShowPassword(true);
        return;
      }
      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: 'Unlock Guard',
        fallbackLabel: 'Use Password',
        disableDeviceFallback: false,
      });
      if (result.success) {
        await unlock('');
      } else {
        // Biometric failed or cancelled — show password fallback
        setShowPassword(true);
      }
    } catch {
      setShowPassword(true);
    } finally {
      setLoading(false);
    }
  }

  async function handlePassword() {
    if (!password.trim()) return;
    setLoading(true);
    try {
      // Re-authenticate with password via API
      const stored = await import('expo-secure-store').then(m => m.getItemAsync('guard_access_token'));
      // Decode email from token or use guardId to look up — just re-login
      await apiClient.post('/auth/guard/verify-password', { password });
      await unlock('');
    } catch {
      Alert.alert('Incorrect Password', 'The password you entered is incorrect. Try again.');
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

      {!showPassword ? (
        <>
          <TouchableOpacity
            style={[styles.button, loading && styles.disabled]}
            onPress={handleBiometric}
            disabled={loading}
          >
            <Text style={styles.buttonText}>
              {loading ? 'VERIFYING...' : 'UNLOCK WITH BIOMETRICS'}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => setShowPassword(true)} style={styles.altLink}>
            <Text style={styles.altText}>Use password instead</Text>
          </TouchableOpacity>
        </>
      ) : (
        <>
          <TextInput
            style={styles.input}
            placeholder="Enter your password"
            placeholderTextColor={Colors.muted}
            secureTextEntry
            value={password}
            onChangeText={setPassword}
            autoFocus
          />
          <TouchableOpacity
            style={[styles.button, (loading || !password.trim()) && styles.disabled]}
            onPress={handlePassword}
            disabled={loading || !password.trim()}
          >
            <Text style={styles.buttonText}>
              {loading ? 'VERIFYING...' : 'UNLOCK'}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => setShowPassword(false)} style={styles.altLink}>
            <Text style={styles.altText}>Use biometrics instead</Text>
          </TouchableOpacity>
        </>
      )}

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
  input: {
    width: '100%', borderWidth: 1, borderColor: Colors.muted,
    borderRadius: Radius.md, padding: Spacing.md,
    color: Colors.base, fontSize: 16, marginBottom: Spacing.md,
  },
  button: {
    width: '100%', backgroundColor: Colors.action,
    borderRadius: Radius.md, padding: Spacing.md, alignItems: 'center',
  },
  disabled:    { opacity: 0.5 },
  buttonText:  { fontFamily: Fonts.heading, color: Colors.structure, fontSize: 17, letterSpacing: 2 },
  altLink:     { marginTop: Spacing.md },
  altText:     { color: Colors.muted, fontSize: 13 },
  logoutLink:  { marginTop: Spacing.xl },
  logoutText:  { color: Colors.muted, fontSize: 13 },
});
