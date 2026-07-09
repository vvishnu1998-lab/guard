/**
 * RequestSwapModal — pre-shift guard-to-guard swap picker.
 *
 * Fetches GET /api/shifts/:id/swap-eligible-guards → { guards: [{ guard_id,
 * name, badge_number, is_same_site }] } which the API already sorts
 * same-site first. We split into two headers for clarity.
 *
 * On REQUEST: POST /api/shifts/:id/swap-request { to_guard_id, reason? }.
 * On 201 the parent screen refetches; API fires notifications separately.
 */
import { useEffect, useState } from 'react';
import {
  Modal, View, Text, StyleSheet, TouchableOpacity, ScrollView,
  TextInput, ActivityIndicator, Alert,
} from 'react-native';
import * as Sentry from '@sentry/react-native';
import { Ionicons } from '@expo/vector-icons';
import { apiClient } from '../lib/apiClient';
import { Colors, Spacing, Radius, Fonts } from '../constants/theme';

interface EligibleGuard {
  guard_id:     string;
  name:         string;
  badge_number: string | null;
  is_same_site: boolean;
}

interface Props {
  shiftId:        string;
  siteName:       string;
  scheduledStart: string;
  scheduledEnd:   string;
  siteTz:         string | null;
  onClose:        () => void;
  onSubmitted:    () => void;
}

const REASON_MAX = 200;

function fmtInTz(iso: string, tz: string | null, opts: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat('en-GB', { ...opts, timeZone: tz ?? undefined }).format(new Date(iso));
}

export default function RequestSwapModal(props: Props) {
  const [guards,    setGuards]    = useState<EligibleGuard[]>([]);
  const [selected,  setSelected]  = useState<string | null>(null);
  const [reason,    setReason]    = useState('');
  const [loading,   setLoading]   = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error,     setError]     = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await apiClient.get<{ guards: EligibleGuard[] }>(
          `/shifts/${props.shiftId}/swap-eligible-guards`,
        );
        if (cancelled) return;
        setGuards(data.guards);
        // Field-diagnostic: on the walk-test 2026-07-09 report a guard's
        // section grouping was mis-read. Capturing the raw is_same_site
        // breakdown here so any future report has a Sentry trail.
        const same  = data.guards.filter((g) => g.is_same_site).length;
        const cross = data.guards.length - same;
        Sentry.addBreadcrumb({
          category: 'swap_modal',
          message: 'eligible_guards_loaded',
          level: 'info',
          data: {
            shift_id:         props.shiftId,
            total_guards:     data.guards.length,
            same_site_count:  same,
            cross_site_count: cross,
            guard_ids:        data.guards.map((g) => g.guard_id),
          },
        });
      } catch (err: any) {
        if (!cancelled) {
          setError(err?.message ?? 'Could not load guards');
          Sentry.captureException(err, { extra: { where: 'RequestSwapModal.fetch' } });
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [props.shiftId]);

  async function submit() {
    if (!selected || submitting) return;
    setSubmitting(true);
    try {
      await apiClient.post(`/shifts/${props.shiftId}/swap-request`, {
        to_guard_id: selected,
        reason:      reason.trim() || undefined,
      });
      props.onSubmitted();
    } catch (err: any) {
      Alert.alert('Could not send request', err?.message ?? 'Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  const sameSite  = guards.filter((g) => g.is_same_site);
  const otherSite = guards.filter((g) => !g.is_same_site);

  return (
    <Modal visible animationType="slide" onRequestClose={props.onClose} transparent={false}>
      <View style={styles.container}>
        {/* Header */}
        <View style={styles.header}>
          <TouchableOpacity onPress={props.onClose} hitSlop={8} style={styles.closeBtn}>
            <Ionicons name="close" size={24} color={Colors.action} />
          </TouchableOpacity>
          <Text style={styles.title}>REQUEST SWAP</Text>
        </View>

        {/* Shift context */}
        <View style={styles.contextCard}>
          <Text style={styles.contextSite}>{props.siteName.toUpperCase()}</Text>
          <Text style={styles.contextTime}>
            {fmtInTz(props.scheduledStart, props.siteTz, {
              weekday: 'short', day: 'numeric', month: 'short',
              hour: '2-digit', minute: '2-digit',
            })}
            {' — '}
            {fmtInTz(props.scheduledEnd, props.siteTz, { hour: '2-digit', minute: '2-digit' })}
          </Text>
        </View>

        <ScrollView style={styles.body} contentContainerStyle={{ paddingBottom: Spacing.xl }}>
          {loading ? (
            <View style={styles.center}>
              <ActivityIndicator color={Colors.action} size="large" />
            </View>
          ) : error ? (
            <View style={styles.center}>
              <Text style={styles.errorText}>{error}</Text>
            </View>
          ) : guards.length === 0 ? (
            <View style={styles.center}>
              <Text style={styles.emptyText}>No guards available</Text>
              <Text style={styles.emptySub}>
                Every other guard in your company either has an overlapping shift or is inactive.
              </Text>
            </View>
          ) : (
            <>
              {sameSite.length > 0 && (
                <>
                  <Text style={[styles.sectionHead, styles.sameSiteHead]}>SAME SITE</Text>
                  {sameSite.map((g) => (
                    <GuardRow
                      key={g.guard_id}
                      guard={g}
                      selected={selected === g.guard_id}
                      onPress={() => setSelected(g.guard_id)}
                    />
                  ))}
                </>
              )}
              {otherSite.length > 0 && (
                <>
                  <Text style={[styles.sectionHead, { marginTop: Spacing.md }]}>OTHER SITES</Text>
                  {sameSite.length === 0 && (
                    <Text style={styles.noSameSiteNote}>
                      No guards assigned to this site are available. Cross-site
                      guards can still cover — they may need on-site orientation.
                    </Text>
                  )}
                  {otherSite.map((g) => (
                    <GuardRow
                      key={g.guard_id}
                      guard={g}
                      selected={selected === g.guard_id}
                      onPress={() => setSelected(g.guard_id)}
                    />
                  ))}
                </>
              )}

              <Text style={[styles.sectionHead, { marginTop: Spacing.lg }]}>REASON (OPTIONAL)</Text>
              <TextInput
                style={styles.reasonInput}
                placeholder="Short note for the other guard…"
                placeholderTextColor={Colors.muted}
                value={reason}
                onChangeText={(t) => setReason(t.slice(0, REASON_MAX))}
                multiline
                maxLength={REASON_MAX}
              />
              <Text style={styles.reasonCounter}>{reason.length}/{REASON_MAX}</Text>
            </>
          )}
        </ScrollView>

        {/* Sticky submit */}
        <View style={styles.footer}>
          <TouchableOpacity
            style={[
              styles.submitBtn,
              (!selected || submitting) && styles.submitBtnDisabled,
            ]}
            onPress={submit}
            disabled={!selected || submitting}
          >
            {submitting
              ? <ActivityIndicator color="#070D1A" />
              : <Text style={styles.submitText}>REQUEST SWAP</Text>}
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

function GuardRow({
  guard, selected, onPress,
}: {
  guard: EligibleGuard; selected: boolean; onPress: () => void;
}) {
  return (
    <TouchableOpacity
      style={[styles.guardRow, selected && styles.guardRowSelected]}
      onPress={onPress}
      activeOpacity={0.7}
    >
      <View style={{ flex: 1 }}>
        <View style={styles.guardNameRow}>
          <Text style={styles.guardName}>{guard.name}</Text>
          {/* Per-row SAME SITE pill — added 2026-07-09 after walk-test
              report of section grouping being mis-read. Makes the
              same-site signal unmissable at the row level regardless
              of whether the tester notices the section header. */}
          {guard.is_same_site && (
            <View style={styles.sameSitePill}>
              <Text style={styles.sameSitePillText}>SAME SITE</Text>
            </View>
          )}
        </View>
        {guard.badge_number
          ? <Text style={styles.guardBadge}>Badge #{guard.badge_number}</Text>
          : null}
      </View>
      {selected && <Ionicons name="checkmark-circle" size={22} color={Colors.action} />}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg },

  header: {
    paddingHorizontal: Spacing.lg,
    paddingTop: 60,
    paddingBottom: Spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
  },
  closeBtn: { padding: 2 },
  title: { fontFamily: Fonts.heading, color: Colors.textPrimary, fontSize: 20, letterSpacing: 4 },

  contextCard: {
    padding: Spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
    backgroundColor: Colors.surface,
  },
  contextSite: { fontFamily: Fonts.heading, color: Colors.textPrimary, fontSize: 15, letterSpacing: 2, marginBottom: 2 },
  contextTime: { color: Colors.muted, fontSize: 13 },

  body: { flex: 1, padding: Spacing.md },

  sectionHead: {
    color: Colors.muted, fontFamily: Fonts.heading,
    fontSize: 11, letterSpacing: 2, marginBottom: Spacing.sm,
  },
  // Green so the same-site grouping is loud — walk-test 2026-07-09
  // caught a case where the muted grey label got mis-read as applying
  // to the wrong rows.
  sameSiteHead: { color: Colors.success },
  noSameSiteNote: {
    color: Colors.muted,
    fontSize: 12,
    fontStyle: 'italic',
    marginBottom: Spacing.sm,
  },

  guardRow: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: Colors.surface,
    borderRadius: Radius.md,
    borderWidth: 1, borderColor: Colors.border,
    padding: Spacing.md,
    marginBottom: Spacing.sm,
  },
  guardRowSelected: {
    borderColor: Colors.action,
    borderWidth: 1.5,
  },
  guardNameRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, marginBottom: 2 },
  guardName:  { color: Colors.textPrimary, fontSize: 15 },
  guardBadge: { color: Colors.muted, fontSize: 12 },
  sameSitePill: {
    backgroundColor: Colors.success,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: Radius.xs,
  },
  sameSitePillText: {
    fontFamily: Fonts.heading,
    color: '#070D1A',
    fontSize: 9,
    letterSpacing: 1,
  },

  reasonInput: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.md,
    borderWidth: 1, borderColor: Colors.border,
    padding: Spacing.md,
    color: Colors.textPrimary,
    fontSize: 14,
    minHeight: 90,
    textAlignVertical: 'top',
  },
  reasonCounter: { color: Colors.muted, fontSize: 11, textAlign: 'right', marginTop: 4 },

  footer: {
    padding: Spacing.md,
    borderTopWidth: 1,
    borderTopColor: Colors.border,
    backgroundColor: Colors.bg,
  },
  submitBtn: {
    backgroundColor: Colors.action,
    borderRadius: Radius.md,
    paddingVertical: Spacing.md,
    alignItems: 'center',
  },
  submitBtnDisabled: { opacity: 0.35 },
  submitText: { fontFamily: Fonts.heading, color: '#070D1A', fontSize: 14, letterSpacing: 2 },

  center: { alignItems: 'center', justifyContent: 'center', padding: Spacing.xl },
  errorText: { color: Colors.textPrimary, fontSize: 14, textAlign: 'center' },
  emptyText: { color: Colors.textPrimary, fontSize: 16, marginBottom: Spacing.xs },
  emptySub:  { color: Colors.muted, fontSize: 13, textAlign: 'center' },
});
