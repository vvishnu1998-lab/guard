/**
 * Login screen — email + password, with show/hide password toggle and a link
 * to the email-only forgot-password flow.
 */
import { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity,
  StyleSheet, Alert, KeyboardAvoidingView, Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import * as Notifications from 'expo-notifications';
import * as Sentry from '@sentry/react-native';
import { useAuthStore } from '../../store/authStore';
import { Colors, Spacing, Radius, Fonts } from '../../constants/theme';
import { ApiError } from '../../lib/errors';
import { guardMessage } from '../../lib/errorCopy';

export default function LoginScreen() {
  const [email, setEmail]       = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading]   = useState(false);

  const { loginWithEmail } = useAuthStore();
  // Set by change-password after a successful change (the server revokes
  // every prior token, so the guard must sign in fresh). Copy matches the
  // web portals' post-change notice (d2a2cba).
  const { notice } = useLocalSearchParams<{ notice?: string }>();
  const passwordChanged = notice === 'password-changed';
  // Set by authStore.logout({ tokenRevoked }) when the server definitively
  // rejected the session (revoked / expired tokens).
  const sessionExpired = notice === 'session-expired';

  async function handleEmailLogin() {
    if (!email.trim() || !password) return;
    setLoading(true);
    try {
      let fcmToken: string | undefined;
      try {
        const { status } = await Notifications.requestPermissionsAsync();
        if (status === 'granted') {
          // Use Expo's push token (not the raw APNs device token).
          // Expo's push service bridges to APNs/FCM so the backend
          // can send via https://exp.host/--/api/v2/push/send.
          const t = await Notifications.getExpoPushTokenAsync({
            projectId: '5fd28125-2461-4165-b9df-7f34ced8b194',
          });
          fcmToken = t.data; // looks like "ExponentPushToken[xxxx]"
        }
      } catch (e) {
        console.warn('Failed to get push token', e);
        Sentry.captureException(e, {
          tags: { flow: 'fcm_token_register_login' },
        });
      }
      await loginWithEmail(email.trim(), password, fcmToken);
      // Navigation handled by root _layout.tsx
    } catch (err: any) {
      // This branch used to test `msg.includes('locked')`. The server's 423
      // body reads "Too many failed attempts. Try again in 30 minutes or
      // contact your supervisor." — it contains no such substring, so the
      // Account Locked dialog had been unreachable ever since that copy was
      // reworded. Nobody noticed because the fallback still showed the
      // server's sentence, which reads fine.
      //
      // Same failure shape as the checkpoint 422 bug: matching on prose
      // instead of on a code. Branch on the status and the body's own flag.
      //
      // The hardcoded copy is dropped in favour of the server's, which is
      // also the more accurate of the two — the lock self-clears after 30
      // minutes (auth.ts auto-unlock), so "Contact your supervisor to
      // unlock" was sending guards to escalate something that resolves
      // itself.
      const locked = err instanceof ApiError
        && (err.status === 423 || err.details?.locked === true);
      Alert.alert(
        locked ? 'Account Locked' : 'Login Failed',
        guardMessage(err, 'Could not sign you in. Check your email and password, then try again.', 'login'),
        [{ text: 'OK' }],
      );
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
        <View style={styles.logoContainer}>
          <Text style={styles.logo}>NetraOps</Text>
          <Text style={styles.tagline}>SECURITY MANAGEMENT</Text>
        </View>

        {passwordChanged && (
          <View style={styles.noticeBanner}>
            <Ionicons name="checkmark-circle-outline" size={18} color={Colors.success} />
            <Text style={styles.noticeText}>
              Password updated — sign in with your new password.
            </Text>
          </View>
        )}
        {sessionExpired && (
          <View style={[styles.noticeBanner, styles.noticeBannerWarning]}>
            <Ionicons name="alert-circle-outline" size={18} color={Colors.warning} />
            <Text style={[styles.noticeText, styles.noticeTextWarning]}>
              Session expired — please sign in again.
            </Text>
          </View>
        )}

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

          <View style={styles.passwordRow}>
            <TextInput
              style={[styles.input, styles.passwordInput]}
              placeholder="Password"
              placeholderTextColor={Colors.muted}
              value={password}
              onChangeText={setPassword}
              secureTextEntry={!showPassword}
              textContentType="password"
              autoComplete="current-password"
            />
            <TouchableOpacity
              style={styles.eyeButton}
              onPress={() => setShowPassword((p) => !p)}
              accessibilityLabel={showPassword ? 'Hide password' : 'Show password'}
            >
              <Ionicons
                name={showPassword ? 'eye-off-outline' : 'eye-outline'}
                size={20}
                color={Colors.muted}
              />
            </TouchableOpacity>
          </View>

          <TouchableOpacity
            style={[styles.submitButton, loading && styles.disabled]}
            onPress={handleEmailLogin}
            disabled={loading}
          >
            <Text style={styles.submitText}>{loading ? 'SIGNING IN...' : 'SIGN IN'}</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.forgotLink}
            onPress={() => router.push('/(auth)/forgot-password')}
          >
            <Text style={styles.forgotText}>Forgot password?</Text>
          </TouchableOpacity>
        </View>
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

  noticeBanner: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
    backgroundColor: Colors.success + '15', borderRadius: Radius.md,
    borderWidth: 1, borderColor: Colors.success + '40',
    padding: Spacing.md, marginBottom: Spacing.lg,
  },
  noticeText:  { color: Colors.success, fontSize: 13, flex: 1, lineHeight: 18 },
  noticeBannerWarning: {
    backgroundColor: Colors.warning + '15', borderColor: Colors.warning + '40',
  },
  noticeTextWarning: { color: Colors.warning },

  form:        { gap: Spacing.md },
  input: {
    backgroundColor: Colors.surface, color: Colors.base,
    borderRadius: Radius.md, padding: Spacing.md, fontSize: 16,
    borderWidth: 1, borderColor: Colors.border,
  },
  passwordRow: { position: 'relative', justifyContent: 'center' },
  passwordInput: { paddingRight: 48 },
  eyeButton: {
    position: 'absolute', right: Spacing.md, top: 0, bottom: 0,
    justifyContent: 'center', paddingHorizontal: Spacing.xs,
  },
  submitButton: {
    backgroundColor: Colors.action, borderRadius: Radius.md,
    padding: Spacing.md, alignItems: 'center',
  },
  disabled:    { opacity: 0.5 },
  submitText:  { fontFamily: Fonts.heading, color: Colors.structure, fontSize: 18, letterSpacing: 3 },

  forgotLink:  { alignItems: 'center', marginTop: Spacing.lg },
  forgotText:  { color: Colors.action, fontSize: 14 },
});
