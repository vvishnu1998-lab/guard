/**
 * Badge / QR login — shared site devices (Section 7)
 * Guard scans their physical badge QR code or enters badge number + PIN.
 * No biometrics stored on shared hardware.
 */
import { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity,
  StyleSheet, Alert, KeyboardAvoidingView, Platform,
} from 'react-native';
import { router } from 'expo-router';
import { useAuthStore } from '../../store/authStore';
import { Colors, Spacing, Radius, Fonts } from '../../constants/theme';

export default function BadgeLoginScreen() {
  const [badgeNumber, setBadgeNumber] = useState('');
  const [pin, setPin]                 = useState('');
  const [loading, setLoading]         = useState(false);
  const { loginWithBadge } = useAuthStore();

  async function handleBadgeLogin() {
    if (!badgeNumber.trim() || !pin) return;
    setLoading(true);
    try {
      await loginWithBadge(badgeNumber.trim(), pin);
    } catch (err: any) {
      Alert.alert('Login Failed', err?.message ?? 'Invalid badge number or PIN');
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
          <Text style={styles.backText}>← Back</Text>
        </TouchableOpacity>

        <Text style={styles.title}>BADGE LOGIN</Text>
        <Text style={styles.subtitle}>
          Enter your badge number and PIN.{'\n'}
          No personal data is stored on this device.
        </Text>

        <View style={styles.form}>
          <Text style={styles.label}>BADGE NUMBER</Text>
          <TextInput
            style={styles.input}
            placeholder="e.g. SG-00142"
            placeholderTextColor={Colors.muted}
            value={badgeNumber}
            onChangeText={setBadgeNumber}
            autoCapitalize="characters"
          />

          <Text style={styles.label}>4–6 DIGIT PIN</Text>
          <TextInput
            style={styles.input}
            placeholder="••••••"
            placeholderTextColor={Colors.muted}
            value={pin}
            onChangeText={setPin}
            keyboardType="number-pad"
            secureTextEntry
            maxLength={6}
          />

          <TouchableOpacity
            style={[styles.button, loading && styles.disabled]}
            onPress={handleBadgeLogin}
            disabled={loading}
          >
            <Text style={styles.buttonText}>{loading ? 'SIGNING IN...' : 'SIGN IN'}</Text>
          </TouchableOpacity>
        </View>

        <Text style={styles.note}>
          Shared device login does not remember your session between uses.
        </Text>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.structure },
  inner:     { flex: 1, padding: Spacing.xl, justifyContent: 'center' },
  back:      { position: 'absolute', top: Spacing.xl, left: Spacing.xl },
  backText:  { color: Colors.action, fontSize: 15 },
  title:     { fontFamily: Fonts.heading, fontSize: 36, color: Colors.base, letterSpacing: 4, marginBottom: Spacing.sm },
  subtitle:  { color: Colors.muted, fontSize: 14, lineHeight: 20, marginBottom: Spacing.xl },
  form:      { gap: Spacing.sm },
  label:     { color: Colors.muted, fontSize: 11, letterSpacing: 3, marginTop: Spacing.sm },
  input: {
    backgroundColor: Colors.surface, color: Colors.base,
    borderRadius: Radius.md, padding: Spacing.md, fontSize: 18,
    borderWidth: 1, borderColor: Colors.border, letterSpacing: 2,
  },
  button: {
    backgroundColor: Colors.action, borderRadius: Radius.md,
    padding: Spacing.md, alignItems: 'center', marginTop: Spacing.md,
  },
  disabled:    { opacity: 0.5 },
  buttonText:  { fontFamily: Fonts.heading, color: Colors.structure, fontSize: 18, letterSpacing: 3 },
  note:        { color: Colors.muted, fontSize: 12, textAlign: 'center', marginTop: Spacing.xl, lineHeight: 18 },
});
