/**
 * Login screen — email + password with biometric fast-login (Section 7)
 * Design: Precision Field — charcoal background, amber CTA
 */
import { useState, useEffect } from 'react';
import {
  View, Text, TextInput, TouchableOpacity,
  StyleSheet, Alert, KeyboardAvoidingView, Platform,
} from 'react-native';
import * as LocalAuthentication from 'expo-local-authentication';
import { router } from 'expo-router';
import { useAuthStore } from '../../store/authStore';
import { Colors, Spacing, Radius, Fonts } from '../../constants/theme';

export default function LoginScreen() {
  const [email, setEmail]       = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading]   = useState(false);
  const [biometricAvailable, setBiometricAvailable] = useState(false);

  const { loginWithEmail, loginWithBiometric } = useAuthStore();

  useEffect(() => {
    (async () => {
      const hasHardware = await LocalAuthentication.hasHardwareAsync();
      const isEnrolled  = await LocalAuthentication.isEnrolledAsync();
      setBiometricAvailable(hasHardware && isEnrolled);
    })();
  }, []);

  async function handleEmailLogin() {
    if (!email.trim() || !password) return;
    setLoading(true);
    try {
      await loginWithEmail(email.trim(), password);
      // Navigation handled by root _layout.tsx
    } catch (err: any) {
      const msg = err?.message ?? 'Login failed';
      if (msg.includes('locked')) {
        Alert.alert(
          'Account Locked',
          'Your account has been locked after 5 failed attempts. Contact your supervisor to unlock.',
          [{ text: 'OK' }]
        );
      } else {
        Alert.alert('Login Failed', msg);
      }
    } finally {
      setLoading(false);
    }
  }

  async function handleBiometric() {
    try {
      await loginWithBiometric();
    } catch (err: any) {
      Alert.alert('Biometric Failed', err?.message ?? 'Could not verify identity');
    }
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <View style={styles.inner}>
        {/* Logo */}
        <View style={styles.logoContainer}>
          <Text style={styles.logo}>V-WING</Text>
          <Text style={styles.tagline}>SECURITY MANAGEMENT</Text>
        </View>

        {/* Biometric fast-login (shown only if available and session exists) */}
        {biometricAvailable && (
          <TouchableOpacity style={styles.biometricButton} onPress={handleBiometric}>
            <Text style={styles.biometricIcon}>⬡</Text>
            <Text style={styles.biometricText}>Sign in with Face ID / Fingerprint</Text>
          </TouchableOpacity>
        )}

        {/* Divider */}
        {biometricAvailable && (
          <View style={styles.divider}>
            <View style={styles.dividerLine} />
            <Text style={styles.dividerText}>OR</Text>
            <View style={styles.dividerLine} />
          </View>
        )}

        {/* Email / Password */}
        <View style={styles.form}>
          <TextInput
            style={styles.input}
            placeholder="Email address"
            placeholderTextColor={Colors.muted}
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            keyboardType="email-address"
            textContentType="emailAddress"
            autoComplete="email"
          />
          <TextInput
            style={styles.input}
            placeholder="Password"
            placeholderTextColor={Colors.muted}
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            textContentType="password"
            autoComplete="current-password"
          />
          <TouchableOpacity
            style={[styles.submitButton, loading && styles.disabled]}
            onPress={handleEmailLogin}
            disabled={loading}
          >
            <Text style={styles.submitText}>{loading ? 'SIGNING IN...' : 'SIGN IN'}</Text>
          </TouchableOpacity>
        </View>

        {/* Badge / QR login for shared devices */}
        <TouchableOpacity
          style={styles.badgeLink}
          onPress={() => router.push('/(auth)/badge-login')}
        >
          <Text style={styles.badgeLinkText}>Shared device? Scan your badge →</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.badgeLink}
          onPress={() => router.push('/(auth)/sms-unlock')}
        >
          <Text style={[styles.badgeLinkText, { color: Colors.danger }]}>
            Account locked? Unlock via SMS →
          </Text>
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.structure },
  inner:     { flex: 1, justifyContent: 'center', padding: Spacing.xl },
  logoContainer: { alignItems: 'center', marginBottom: Spacing.xxl },
  logo:      { fontFamily: Fonts.heading, fontSize: 52, color: Colors.action, letterSpacing: 12 },
  tagline:   { color: Colors.muted, fontSize: 11, letterSpacing: 4, marginTop: Spacing.xs },

  biometricButton: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: Spacing.sm, borderWidth: 1.5, borderColor: Colors.action,
    borderRadius: Radius.lg, padding: Spacing.md, marginBottom: Spacing.lg,
  },
  biometricIcon: { fontSize: 20, color: Colors.action },
  biometricText: { color: Colors.action, fontSize: 15, letterSpacing: 0.5 },

  divider:     { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, marginBottom: Spacing.lg },
  dividerLine: { flex: 1, height: 1, backgroundColor: Colors.border },
  dividerText: { color: Colors.muted, fontSize: 12, letterSpacing: 2 },

  form:        { gap: Spacing.md },
  input: {
    backgroundColor: Colors.surface, color: Colors.base,
    borderRadius: Radius.md, padding: Spacing.md, fontSize: 16,
    borderWidth: 1, borderColor: Colors.border,
  },
  submitButton: {
    backgroundColor: Colors.action, borderRadius: Radius.md,
    padding: Spacing.md, alignItems: 'center',
  },
  disabled:    { opacity: 0.5 },
  submitText:  { fontFamily: Fonts.heading, color: Colors.structure, fontSize: 18, letterSpacing: 3 },

  badgeLink:     { alignItems: 'center', marginTop: Spacing.xl },
  badgeLinkText: { color: Colors.muted, fontSize: 13 },
});
