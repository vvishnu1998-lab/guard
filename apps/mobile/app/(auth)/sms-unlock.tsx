/**
 * SMS Self-Service Unlock (Section 7 — "supervisor unlock" fallback)
 * Shown when guard is locked out and no supervisor is reachable.
 * Requires phone_number to be registered on their Guard account.
 */
import { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity,
  StyleSheet, Alert, KeyboardAvoidingView, Platform,
} from 'react-native';
import { router } from 'expo-router';
import { useAuthStore } from '../../store/authStore';
import { Colors, Spacing, Radius, Fonts } from '../../constants/theme';

const API = process.env.EXPO_PUBLIC_API_URL;

type Step = 'request' | 'verify';

export default function SmsUnlockScreen() {
  const [step, setStep]         = useState<Step>('request');
  const [email, setEmail]       = useState('');
  const [otp, setOtp]           = useState('');
  const [loading, setLoading]   = useState(false);

  const { loginWithEmail } = useAuthStore();

  async function handleRequest() {
    if (!email.trim()) return;
    setLoading(true);
    try {
      await fetch(`${API}/api/auth/guard/request-unlock`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim() }),
      });
      // Always show the next step regardless of response (prevents enumeration)
      setStep('verify');
    } catch {
      Alert.alert('Error', 'Network error. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  async function handleVerify() {
    if (!otp.trim()) return;
    setLoading(true);
    try {
      const res = await fetch(`${API}/api/auth/guard/verify-unlock`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), otp: otp.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        Alert.alert('Invalid Code', data.error ?? 'The code is incorrect or has expired.');
        return;
      }
      // Unlock succeeded — navigate to home (authStore will be updated on next load)
      Alert.alert('Account Unlocked', 'Your account has been unlocked. Please sign in.', [
        { text: 'Sign In', onPress: () => router.replace('/(auth)/login') },
      ]);
    } catch {
      Alert.alert('Error', 'Network error. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <View style={styles.inner}>
        <TouchableOpacity style={styles.back} onPress={() => router.back()}>
          <Text style={styles.backText}>← Back to login</Text>
        </TouchableOpacity>

        <Text style={styles.title}>UNLOCK ACCOUNT</Text>

        {step === 'request' ? (
          <>
            <Text style={styles.subtitle}>
              Enter your email address. If a phone number is registered on your account,
              you will receive a 6-digit unlock code by SMS.
            </Text>
            <Text style={styles.label}>EMAIL ADDRESS</Text>
            <TextInput
              style={styles.input}
              placeholder="your@email.com"
              placeholderTextColor={Colors.muted}
              value={email}
              onChangeText={setEmail}
              autoCapitalize="none"
              keyboardType="email-address"
            />
            <TouchableOpacity
              style={[styles.button, loading && styles.disabled]}
              onPress={handleRequest}
              disabled={loading}
            >
              <Text style={styles.buttonText}>{loading ? 'SENDING...' : 'SEND UNLOCK CODE'}</Text>
            </TouchableOpacity>
          </>
        ) : (
          <>
            <Text style={styles.subtitle}>
              Enter the 6-digit code sent to your registered phone number.
              The code expires in 10 minutes.
            </Text>
            <Text style={styles.label}>6-DIGIT CODE</Text>
            <TextInput
              style={[styles.input, styles.otpInput]}
              placeholder="000000"
              placeholderTextColor={Colors.muted}
              value={otp}
              onChangeText={setOtp}
              keyboardType="number-pad"
              maxLength={6}
              autoFocus
            />
            <TouchableOpacity
              style={[styles.button, loading && styles.disabled]}
              onPress={handleVerify}
              disabled={loading}
            >
              <Text style={styles.buttonText}>{loading ? 'VERIFYING...' : 'UNLOCK ACCOUNT'}</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => { setStep('request'); setOtp(''); }} style={styles.resend}>
              <Text style={styles.resendText}>Resend code</Text>
            </TouchableOpacity>
          </>
        )}

        <View style={styles.supervisorNote}>
          <Text style={styles.supervisorText}>
            No phone number registered? Contact your supervisor to unlock your account.
          </Text>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container:  { flex: 1, backgroundColor: Colors.structure },
  inner:      { flex: 1, padding: Spacing.xl, justifyContent: 'center' },
  back:       { position: 'absolute', top: Spacing.xl, left: Spacing.xl },
  backText:   { color: Colors.action, fontSize: 15 },
  title:      { fontFamily: Fonts.heading, fontSize: 36, color: Colors.base, letterSpacing: 4, marginBottom: Spacing.sm },
  subtitle:   { color: Colors.muted, fontSize: 14, lineHeight: 22, marginBottom: Spacing.xl },
  label:      { color: Colors.muted, fontSize: 11, letterSpacing: 3, marginBottom: Spacing.sm },
  input: {
    backgroundColor: Colors.surface, color: Colors.base,
    borderRadius: Radius.md, padding: Spacing.md, fontSize: 16,
    borderWidth: 1, borderColor: Colors.border, marginBottom: Spacing.md,
  },
  otpInput:   { fontSize: 28, letterSpacing: 12, textAlign: 'center' },
  button: {
    backgroundColor: Colors.action, borderRadius: Radius.md,
    padding: Spacing.md, alignItems: 'center',
  },
  disabled:     { opacity: 0.5 },
  buttonText:   { fontFamily: Fonts.heading, color: Colors.structure, fontSize: 18, letterSpacing: 2 },
  resend:       { alignItems: 'center', marginTop: Spacing.md },
  resendText:   { color: Colors.action, fontSize: 13 },
  supervisorNote: {
    marginTop: Spacing.xxl, padding: Spacing.md,
    backgroundColor: Colors.surface, borderRadius: Radius.md,
    borderWidth: 1, borderColor: Colors.border,
  },
  supervisorText: { color: Colors.muted, fontSize: 13, lineHeight: 20, textAlign: 'center' },
});
