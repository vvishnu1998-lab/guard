/**
 * Checkpoint Setup (C6, Phase 2) — list of UNLINKED checkpoints at the
 * guard's active site. Reachable only via the active-shift banner (which
 * renders only when GET /checkpoints/mine reports unlinked > 0).
 *
 * Selecting a checkpoint opens the scanner in link mode with that
 * checkpoint_id. On return (useFocusEffect) the list refetches; linked
 * ones drop out, and when it empties the guard is sent back — the
 * shift-screen banner disappears on its own next refresh.
 */
import { useCallback, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, ActivityIndicator } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { apiClient, ApiError } from '../../lib/apiClient';
import { Colors, Spacing, Radius, Fonts } from '../../constants/theme';

interface MineCheckpoint {
  id: string;
  label: string;
  sort_order: number;
  linked: boolean;
  scanned_this_window: boolean;
}

interface MineResponse {
  site_id: string;
  round_window: string;
  total: number;
  scanned: number;
  unlinked: number;
  checkpoints: MineCheckpoint[];
}

export default function CheckpointSetup() {
  const [unlinked, setUnlinked] = useState<MineCheckpoint[] | null>(null);
  const [error, setError] = useState('');

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      (async () => {
        try {
          const mine = await apiClient.get<MineResponse>('/checkpoints/mine');
          if (cancelled) return;
          setUnlinked(mine.checkpoints.filter((c) => !c.linked));
          setError('');
        } catch (err: any) {
          if (cancelled) return;
          if (err instanceof ApiError && err.status === 403) {
            setError('Clock in to set up checkpoints.');
          } else {
            setError(err?.message ?? 'Could not load checkpoints.');
          }
          setUnlinked([]);
        }
      })();
      return () => { cancelled = true; };
    }, []),
  );

  return (
    <ScrollView style={styles.bg} contentContainerStyle={styles.scroll}>
      <Text style={styles.step}>CHECKPOINT SETUP</Text>
      <Text style={styles.title}>ANCHOR PHYSICAL TAGS</Text>

      <Text style={styles.explainer}>
        Walk to each checkpoint below, then scan its physical tag. The scan
        records the tag's code and your GPS position as the checkpoint's anchor.
      </Text>

      {error !== '' && (
        <View style={styles.errorCard}><Text style={styles.errorText}>{error}</Text></View>
      )}

      {unlinked === null ? (
        <ActivityIndicator size="large" color={Colors.action} style={{ marginTop: Spacing.xl }} />
      ) : unlinked.length === 0 && error === '' ? (
        <View style={styles.doneCard}>
          <Text style={styles.doneTitle}>✓ ALL CHECKPOINTS SET UP</Text>
          <Text style={styles.doneText}>Every checkpoint at this site is anchored.</Text>
        </View>
      ) : (
        unlinked.map((cp) => (
          <TouchableOpacity
            key={cp.id}
            style={styles.cpRow}
            onPress={() =>
              router.push({
                pathname: '/checkpoints/scan',
                params: { mode: 'link', checkpoint_id: cp.id, label: cp.label },
              })
            }
          >
            <View style={styles.cpDot} />
            <Text style={styles.cpLabel}>{cp.label}</Text>
            <Text style={styles.cpChevron}>›</Text>
          </TouchableOpacity>
        ))
      )}

      <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
        <Text style={styles.backText}>BACK TO SHIFT</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  bg:     { flex: 1, backgroundColor: Colors.structure },
  scroll: { alignItems: 'center', paddingBottom: 48 },

  step:  { color: Colors.muted, fontSize: 11, letterSpacing: 4, marginTop: Spacing.xl, marginBottom: 2 },
  title: { color: Colors.action, fontFamily: Fonts.heading, fontSize: 18, letterSpacing: 3, marginBottom: Spacing.md },

  explainer: {
    width: '92%', color: Colors.muted, fontSize: 13, lineHeight: 19,
    textAlign: 'center', marginBottom: Spacing.lg,
  },

  errorCard: {
    width: '92%', backgroundColor: Colors.surface, borderRadius: Radius.md,
    borderWidth: 1, borderColor: Colors.danger, padding: Spacing.md, marginBottom: Spacing.md,
  },
  errorText: { color: Colors.danger, fontSize: 13, textAlign: 'center' },

  doneCard: {
    width: '92%', backgroundColor: Colors.surface, borderRadius: Radius.lg,
    borderWidth: 1, borderColor: Colors.success, padding: Spacing.lg,
    alignItems: 'center', gap: Spacing.sm,
  },
  doneTitle: { color: Colors.success, fontFamily: Fonts.heading, fontSize: 16, letterSpacing: 2 },
  doneText:  { color: Colors.muted, fontSize: 13 },

  cpRow: {
    width: '92%', flexDirection: 'row', alignItems: 'center',
    backgroundColor: Colors.surface, borderRadius: Radius.lg,
    borderWidth: 1, borderColor: Colors.border,
    padding: Spacing.lg, marginBottom: Spacing.sm, gap: Spacing.md,
  },
  cpDot:     { width: 10, height: 10, borderRadius: 5, backgroundColor: Colors.warning },
  cpLabel:   { flex: 1, color: Colors.base, fontSize: 15 },
  cpChevron: { color: Colors.muted, fontSize: 22 },

  backBtn:  { marginTop: Spacing.xl, padding: Spacing.md },
  backText: { color: Colors.muted, fontSize: 12, letterSpacing: 3 },
});
