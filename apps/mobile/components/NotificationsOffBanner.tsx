/**
 * "Ping reminders are off" — shown while this phone cannot receive them
 * (N173). Tap asks for permission when the OS still will, otherwise opens
 * this app's page in Settings; it disappears as soon as notifications are on
 * (the token is registered then — hooks/useNotificationPermission.ts).
 *
 * Deliberately not dismissible: a guard who never sees a reminder is marked
 * down for every window they miss, and this is the only place they learn
 * why. Same card as UnsentWritesBanner and pinned beside it above Home's
 * ScrollView, for the same reason — a warning below the fold is not a
 * warning. Renders null, margins included, when there is nothing to say.
 */
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { Colors, Spacing, Radius, Fonts } from '../constants/theme';
import { notificationsBannerFor } from '../lib/notificationsBanner';
import { useNotificationPermission } from '../hooks/useNotificationPermission';

export default function NotificationsOffBanner() {
  const { permission, resolve } = useNotificationPermission();
  const banner = notificationsBannerFor(permission);
  if (!banner) return null;

  return (
    <TouchableOpacity
      style={styles.card}
      onPress={() => { void resolve(banner.action); }}
      accessibilityRole="button"
      accessibilityLabel={`${banner.title}. ${banner.sub}`}
    >
      <View style={styles.info}>
        <Text style={styles.title}>{banner.title}</Text>
        <Text style={styles.sub}>{banner.sub}</Text>
      </View>
      <Text style={styles.chevron}>›</Text>
    </TouchableOpacity>
  );
}

// Mirrors components/UnsentWritesBanner.tsx's card.
const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.surface2,
    borderWidth: 1,
    borderColor: Colors.warning,
    borderRadius: Radius.md,
    padding: Spacing.md,
    marginTop: Spacing.md,
    marginBottom: Spacing.md,
  },
  info:  { flex: 1 },
  title: {
    fontFamily: Fonts.heading,
    fontSize: 15,
    letterSpacing: 0.5,
    color: Colors.warning,
    marginBottom: 2,
  },
  sub:   { fontFamily: Fonts.body, fontSize: 13, color: Colors.muted, lineHeight: 18 },
  chevron: { fontSize: 26, color: Colors.warning, marginLeft: Spacing.sm },
});
