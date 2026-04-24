/**
 * Force password change — shown on first login (Section 7)
 * Guard cannot proceed to home until they set a new password.
 */
import { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity,
  StyleSheet, Alert, KeyboardAvoidingView, Platform, ScrollView,
} from 'react-native';
import { useAuthStore } from '../../store/authStore';
import { Colors, Spacing, Radius, Fonts } from '../../constants/theme';

export default function ChangePasswordScreen() {
  const [current, setCurrent]     = useState('');
  const [next, setNext]           = useState('');
  const [confirm, setConfirm]     = useState('');
  const [loading, setLoading]     = useState(false);
  const { changePassword, logout } = useAuthStore();

  async function handleChange() {
    if (next.length < 12) {
      Alert.alert('Too short', 'New password must be at least 12 characters.'); return;
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

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <ScrollView contentContainerStyle={styles.inner} keyboardShouldPersistTaps="handled">
        <View style={styles.badge}>
          <Text style={styles.badgeText}>FIRST LOGIN</Text>
        </View>
        <Text style={styles.title}>SET YOUR PASSWORD</Text>
        <Text style={styles.subtitle}>
          Your account was created with a temporary password.{'\n'}
          Set a personal password to continue.
        </Text>

        <View style={styles.form}>
          <Text style={styles.label}>TEMPORARY PASSWORD</Text>
          <TextInput
            style={styles.input}
            placeholder="Enter temporary password"
            placeholderTextColor={Colors.muted}
            value={current}
            onChangeText={setCurrent}
            secureTextEntry
            textContentType="password"
          />
          <Text style={styles.label}>NEW PASSWORD</Text>
          <TextInput
            style={styles.input}
            placeholder="At least 8 characters"
            placeholderTextColor={Colors.muted}
            value={next}
            onChangeText={setNext}
            secureTextEntry
            textContentType="newPassword"
          />
          <Text style={styles.label}>CONFIRM NEW PASSWORD</Text>
          <TextInput
            style={styles.input}
            placeholder="Repeat new password"
            placeholderTextColor={Colors.muted}
            value={confirm}
            onChangeText={setConfirm}
            secureTextEntry
          />

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
  button: {
    backgroundColor: Colors.action, borderRadius: Radius.md,
    padding: Spacing.md, alignItems: 'center', marginTop: Spacing.lg,
  },
  disabled:    { opacity: 0.5 },
  buttonText:  { fontFamily: Fonts.heading, color: Colors.structure, fontSize: 16, letterSpacing: 2 },
  logoutLink:  { alignItems: 'center', marginTop: Spacing.xl },
  logoutText:  { color: Colors.muted, fontSize: 13 },
});
