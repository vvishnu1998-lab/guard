/**
 * Forgot password — email-only flow. Server emails a temporary password and
 * flips must_change_password=true; user logs in with that temp and is forced
 * to set a new password.
 */
import { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity,
  StyleSheet, Alert, KeyboardAvoidingView, Platform,
} from 'react-native';
import { router } from 'expo-router';
import { useAuthStore } from '../../store/authStore';
import { Colors, Spacing, Radius, Fonts } from '../../constants/theme';

export default function ForgotPasswordScreen() {
  const [email, setEmail]     = useState('');
  const [loading, setLoading] = useState(false);
  const [sent, setSent]       = useState(false);
  const { forgotPassword }    = useAuthStore();

  async function handleSubmit() {
    if (!email.trim()) return;
    setLoading(true);
    try {
      await forgotPassword(email.trim());
      setSent(true);
    } catch (err: any) {
      Alert.alert('Error', err?.message ?? 'Could not send temporary password');
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
        <Text style={styles.title}>FORGOT PASSWORD</Text>
        <Text style={styles.subtitle}>
          Enter your email and we&apos;ll send you a temporary password.{'\n'}
          You&apos;ll be required to change it on next login.
        </Text>

        {sent ? (
          <View>
            <View style={styles.successBox}>
              <Text style={styles.successText}>
                If that email is registered, a temporary password has been sent.
              </Text>
            </View>
            <TouchableOpacity
              style={styles.submitButton}
              onPress={() => router.replace('/(auth)/login')}
            >
              <Text style={styles.submitText}>BACK TO SIGN IN</Text>
            </TouchableOpacity>
          </View>
        ) : (
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
            <TouchableOpacity
              style={[styles.submitButton, loading && styles.disabled]}
              onPress={handleSubmit}
              disabled={loading || !email.trim()}
            >
              <Text style={styles.submitText}>{loading ? 'SENDING...' : 'SEND TEMPORARY PASSWORD'}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.backLink}
              onPress={() => router.replace('/(auth)/login')}
            >
              <Text style={styles.backText}>← Back to sign in</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.structure },
  inner:     { flex: 1, justifyContent: 'center', padding: Spacing.xl },
  title:     { fontFamily: Fonts.heading, fontSize: 32, color: Colors.base, letterSpacing: 2, marginBottom: Spacing.sm },
  subtitle:  { color: Colors.muted, fontSize: 14, lineHeight: 22, marginBottom: Spacing.xl },
  form:      { gap: Spacing.md },
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
  submitText:  { fontFamily: Fonts.heading, color: Colors.structure, fontSize: 16, letterSpacing: 2 },
  backLink:    { alignItems: 'center', marginTop: Spacing.lg },
  backText:    { color: Colors.muted, fontSize: 13 },
  successBox:  {
    backgroundColor: Colors.action + '15', borderRadius: Radius.md,
    padding: Spacing.lg, marginBottom: Spacing.lg,
    borderWidth: 1, borderColor: Colors.action + '40',
  },
  successText: { color: Colors.action, fontSize: 14, lineHeight: 22 },
});
