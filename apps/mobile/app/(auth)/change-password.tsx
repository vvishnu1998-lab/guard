/**
 * Force password change — shown after first login OR after forgot-password
 * temp-password issuance. Guard cannot proceed to home until they set a new
 * valid password (6–8 characters).
 */
import { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity,
  StyleSheet, Alert, KeyboardAvoidingView, Platform, ScrollView,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useAuthStore } from '../../store/authStore';
import { Colors, Spacing, Radius, Fonts } from '../../constants/theme';

export default function ChangePasswordScreen() {
  const [current, setCurrent]     = useState('');
  const [next, setNext]           = useState('');
  const [confirm, setConfirm]     = useState('');
  const [showCurrent, setShowCurrent] = useState(false);
  const [showNext, setShowNext]   = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [loading, setLoading]     = useState(false);
  const { changePassword, logout } = useAuthStore();

  async function handleChange() {
    if (next.length < 6 || next.length > 8) {
      Alert.alert('Invalid', 'New password must be 6–8 characters.'); return;
    }
    if (next !== confirm) {
      Alert.alert('Mismatch', 'New passwords do not match.'); return;
    }
    setLoading(true);
    try {
      await changePassword(current, next);
      // Root layout will redirect to home once mustChangePassword = false
    } catch (err: any) {
      Alert.alert('Error', err?.message ?? 'Could not change password');
    } finally {
      setLoading(false);
    }
  }

  function renderEye(visible: boolean, toggle: () => void) {
    return (
      <TouchableOpacity style={styles.eyeButton} onPress={toggle}>
        <Ionicons
          name={visible ? 'eye-off-outline' : 'eye-outline'}
          size={20}
          color={Colors.muted}
        />
      </TouchableOpacity>
    );
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <ScrollView contentContainerStyle={styles.inner} keyboardShouldPersistTaps="handled">
        <View style={styles.badge}>
          <Text style={styles.badgeText}>SET PASSWORD</Text>
        </View>
        <Text style={styles.title}>SET YOUR PASSWORD</Text>
        <Text style={styles.subtitle}>
          Enter your current (or temporary) password,{'\n'}
          then choose a new 6–8 character password.
        </Text>

        <View style={styles.form}>
          <Text style={styles.label}>CURRENT / TEMPORARY PASSWORD</Text>
          <View style={styles.passwordRow}>
            <TextInput
              style={[styles.input, styles.passwordInput]}
              placeholder="Enter current password"
              placeholderTextColor={Colors.muted}
              value={current}
              onChangeText={setCurrent}
              secureTextEntry={!showCurrent}
              textContentType="password"
            />
            {renderEye(showCurrent, () => setShowCurrent((p) => !p))}
          </View>

          <Text style={styles.label}>NEW PASSWORD</Text>
          <View style={styles.passwordRow}>
            <TextInput
              style={[styles.input, styles.passwordInput]}
              placeholder="6–8 characters"
              placeholderTextColor={Colors.muted}
              value={next}
              onChangeText={setNext}
              secureTextEntry={!showNext}
              textContentType="newPassword"
            />
            {renderEye(showNext, () => setShowNext((p) => !p))}
          </View>

          <Text style={styles.label}>CONFIRM NEW PASSWORD</Text>
          <View style={styles.passwordRow}>
            <TextInput
              style={[styles.input, styles.passwordInput]}
              placeholder="Repeat new password"
              placeholderTextColor={Colors.muted}
              value={confirm}
              onChangeText={setConfirm}
              secureTextEntry={!showConfirm}
            />
            {renderEye(showConfirm, () => setShowConfirm((p) => !p))}
          </View>

          <TouchableOpacity
            style={[styles.button, loading && styles.disabled]}
            onPress={handleChange}
            disabled={loading}
          >
            <Text style={styles.buttonText}>{loading ? 'SAVING...' : 'SET PASSWORD & CONTINUE'}</Text>
          </TouchableOpacity>
        </View>

        <TouchableOpacity onPress={logout} style={styles.logoutLink}>
          <Text style={styles.logoutText}>Not you? Log out</Text>
        </TouchableOpacity>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.structure },
  inner:     { flexGrow: 1, padding: Spacing.xl, justifyContent: 'center' },
  badge: {
    backgroundColor: Colors.action + '20', borderRadius: Radius.sm,
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.xs,
    alignSelf: 'flex-start', marginBottom: Spacing.md,
  },
  badgeText: { color: Colors.action, fontSize: 11, letterSpacing: 3, fontFamily: Fonts.heading },
  title:     { fontFamily: Fonts.heading, fontSize: 32, color: Colors.base, letterSpacing: 2, marginBottom: Spacing.sm },
  subtitle:  { color: Colors.muted, fontSize: 14, lineHeight: 22, marginBottom: Spacing.xl },
  form:      { gap: Spacing.xs },
  label:     { color: Colors.muted, fontSize: 11, letterSpacing: 3, marginTop: Spacing.md },
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
  button: {
    backgroundColor: Colors.action, borderRadius: Radius.md,
    padding: Spacing.md, alignItems: 'center', marginTop: Spacing.lg,
  },
  disabled:    { opacity: 0.5 },
  buttonText:  { fontFamily: Fonts.heading, color: Colors.structure, fontSize: 16, letterSpacing: 2 },
  logoutLink:  { alignItems: 'center', marginTop: Spacing.xl },
  logoutText:  { color: Colors.muted, fontSize: 13 },
});
