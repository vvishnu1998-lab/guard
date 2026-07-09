/**
 * HandoffRequestModal — mid-shift handoff picker.
 *
 * Structurally mirrors RequestSwapModal but for active shifts:
 *   - Header: "Hand off remaining shift — X hours left until <end>"
 *   - Fetches /shifts/:id/swap-eligible-guards?context=handoff which
 *     applies the stricter Phase 2b filter (excludes guards with any
 *     open shift_session + overlap check against remaining window only).
 *   - OTHER SITES header includes a "Not familiar with this site" hint
 *     so the requester knows a cross-site coverage means the recipient
 *     will need site orientation on arrival.
 *
 * Success flow: POST /handoff-request → 1.5s "Waiting for <name>…" state
 * → onSubmitted() dismisses the modal. Parent (shifts/[id]) refetches on
 * focus so the just-created pending row is visible.
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
  shiftId:       string;
  siteName:      string;
  scheduledEnd:  string;
  siteTz:        string | null;
  onClose:       () => void;
  onSubmitted:   () => void;
}

const REASON_MAX = 200;
const WAITING_HOLD_MS = 1500;

function fmtInTz(iso: string, tz: string | null, opts: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat('en-GB', { ...opts, timeZone: tz ?? undefined }).format(new Date(iso));
}

function hoursLeftUntil(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return '0h';
  const h = ms / 3_600_000;
  return h < 1 ? `${Math.max(1, Math.round(h * 60))}m` : `${h.toFixed(1)}h`;
}

export default function HandoffRequestModal(props: Props) {
  const [guards,     setGuards]     = useState<EligibleGuard[]>([]);
  const [selected,   setSelected]   = useState<string | null>(null);
  const [reason,     setReason]     = useState('');
  const [loading,    setLoading]    = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [waiting,    setWaiting]    = useState<string | null>(null);
  const [error,      setError]      = useState<string | null>(null);

  useEffect(() => {
    Sentry.addBreadcrumb({
      category: 'handoff_wizard',
      message: 'HandoffRequestModal mounted',
      level: 'info',
      data: { shift_id: props.shiftId, site: props.siteName },
    });
    let cancelled = false;
    (async () => {
      try {
        const data = await apiClient.get<{ guards: EligibleGuard[] }>(
          `/shifts/${props.shiftId}/swap-eligible-guards?context=handoff`,
        );
        if (!cancelled) {
          setGuards(data.guards);
          // Field-diagnostic: on the walk-test 2026-07-09 report a guard's
          // section grouping was mis-read. Capturing the raw is_same_site
          // breakdown here so any future report has a Sentry trail.
          const same  = data.guards.filter((g) => g.is_same_site).length;
          const cross = data.guards.length - same;
          Sentry.addBreadcrumb({
            category: 'handoff_modal',
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
        }
      } catch (err: any) {
        if (!cancelled) {
          setError(err?.message ?? 'Could not load guards');
          Sentry.captureException(err, { extra: { where: 'HandoffRequestModal.fetch' } });
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [props.shiftId, props.siteName]);

  async function submit() {
    if (!selected || submitting) return;
    setSubmitting(true);
    const target = guards.find((g) => g.guard_id === selected);
    Sentry.addBreadcrumb({
      category: 'handoff_wizard',
      message: 'submit initiated',
      level: 'info',
      data: { to_guard_id: selected, has_reason: reason.trim().length > 0 },
    });
    try {
      await apiClient.post(`/shifts/${props.shiftId}/handoff-request`, {
        to_guard_id: selected,
        reason:      reason.trim() || undefined,
      });
      Sentry.addBreadcrumb({
        category: 'handoff_wizard',
        message: 'handoff-request submitted',
        level: 'info',
      });
      setWaiting(target?.name ?? 'guard');
      // Give the user a beat to see "Waiting for X to respond…" before we
      // dismiss the modal. Parent screen refetches on focus and shows the
      // new pending row.
      setTimeout(() => props.onSubmitted(), WAITING_HOLD_MS);
    } catch (err: any) {
      Sentry.addBreadcrumb({
        category: 'handoff_wizard',
        message: 'submit failed',
        level: 'error',
        data: { error: err?.message ?? String(err) },
      });
      Sentry.captureException(err, { extra: { where: 'HandoffRequestModal.submit' } });
      Alert.alert('Could not send handoff', err?.message ?? 'Please try again.');
      setSubmitting(false);
    }
  }

  const sameSite  = guards.filter((g) => g.is_same_site);
  const otherSite = guards.filter((g) => !g.is_same_site);
  const hoursLeft = hoursLeftUntil(props.scheduledEnd);
  const endsAt    = fmtInTz(props.scheduledEnd, props.siteTz, { hour: '2-digit', minute: '2-digit' });

  return (
    <Modal visible animationType="slide" onRequestClose={props.onClose} transparent={false}>
      <View style={styles.container}>
        {/* Header */}
        <View style={styles.header}>
          <TouchableOpacity onPress={props.onClose} hitSlop={8} style={styles.closeBtn} disabled={!!waiting}>
            <Ionicons name="close" size={24} color={waiting ? Colors.muted : Colors.warning} />
          </TouchableOpacity>
          <Text style={styles.title}>HAND OFF SHIFT</Text>
        </View>

        {/* Context strip */}
        <View style={styles.contextCard}>
          <Text style={styles.contextSite}>{props.siteName.toUpperCase()}</Text>
          <Text style={styles.contextTime}>
            {hoursLeft} left · ends at {endsAt}
          </Text>
        </View>

        <ScrollView style={styles.body} contentContainerStyle={{ paddingBottom: Spacing.xl }}>
          {loading ? (
            <View style={styles.center}>
              <ActivityIndicator color={Colors.warning} size="large" />
            </View>
          ) : waiting ? (
            <View style={styles.center}>
              <ActivityIndicator color={Colors.warning} size="large" />
              <Text style={styles.waitingText}>Waiting for {waiting} to respond…</Text>
            </View>
          ) : error ? (
            <View style={styles.center}>
              <Text style={styles.errorText}>{error}</Text>
            </View>
          ) : guards.length === 0 ? (
            <View style={styles.center}>
              <Text style={styles.emptyText}>No guards available</Text>
              <Text style={styles.emptySub}>
                Every other guard in your company is currently clocked in, has
                an overlapping shift, or is inactive.
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
                      onPress={() => {
                        setSelected(g.guard_id);
                        Sentry.addBreadcrumb({
                          category: 'handoff_wizard',
                          message: 'guard selected',
                          level: 'info',
                          data: { to_guard_id: g.guard_id, is_same_site: g.is_same_site },
                        });
                      }}
                    />
                  ))}
                </>
              )}
              {otherSite.length > 0 && (
                <>
                  <View style={styles.otherSitesHeaderRow}>
                    <Text style={[styles.sectionHead, { marginBottom: 0 }]}>OTHER SITES</Text>
                    <Text style={styles.otherSitesHint}>Not familiar with this site</Text>
                  </View>
                  {sameSite.length === 0 && (
                    <Text style={styles.noSameSiteNote}>
                      No guards assigned to this site are available. Cross-site
                      guards can still cover but will need on-site orientation.
                    </Text>
                  )}
                  {otherSite.map((g) => (
                    <GuardRow
                      key={g.guard_id}
                      guard={g}
                      selected={selected === g.guard_id}
                      onPress={() => {
                        setSelected(g.guard_id);
                        Sentry.addBreadcrumb({
                          category: 'handoff_wizard',
                          message: 'guard selected',
                          level: 'info',
                          data: { to_guard_id: g.guard_id, is_same_site: g.is_same_site },
                        });
                      }}
                    />
                  ))}
                </>
              )}

              <Text style={[styles.sectionHead, { marginTop: Spacing.lg }]}>REASON (OPTIONAL)</Text>
              <TextInput
                style={styles.reasonInput}
                placeholder="e.g. family emergency, feeling unwell…"
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

        {/* Sticky submit — hidden while waiting for parent to dismiss us */}
        {!waiting && (
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
                : <Text style={styles.submitText}>REQUEST HANDOFF</Text>}
            </TouchableOpacity>
          </View>
        )}
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
          {/* Per-row SAME SITE pill — symmetric with RequestSwapModal.
              Added 2026-07-09 after the walk-test report of section
              grouping being mis-read. */}
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
      {selected && <Ionicons name="checkmark-circle" size={22} color={Colors.warning} />}
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
  contextTime: { color: Colors.warning, fontSize: 13 },

  body: { flex: 1, padding: Spacing.md },

  sectionHead: {
    color: Colors.muted, fontFamily: Fonts.heading,
    fontSize: 11, letterSpacing: 2, marginBottom: Spacing.sm,
  },
  otherSitesHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: Spacing.md,
    marginBottom: Spacing.sm,
  },
  otherSitesHint: {
    color: Colors.warning,
    fontSize: 11,
    fontStyle: 'italic',
  },
  // Green so the same-site grouping is loud — matches RequestSwapModal.
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
    borderColor: Colors.warning,
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
    backgroundColor: Colors.warning,
    borderRadius: Radius.md,
    paddingVertical: Spacing.md,
    alignItems: 'center',
  },
  submitBtnDisabled: { opacity: 0.35 },
  submitText: { fontFamily: Fonts.heading, color: '#070D1A', fontSize: 14, letterSpacing: 2 },

  center: { alignItems: 'center', justifyContent: 'center', padding: Spacing.xl, gap: Spacing.md },
  waitingText: { color: Colors.textPrimary, fontSize: 15, textAlign: 'center' },
  errorText: { color: Colors.textPrimary, fontSize: 14, textAlign: 'center' },
  emptyText: { color: Colors.textPrimary, fontSize: 16, marginBottom: Spacing.xs },
  emptySub:  { color: Colors.muted, fontSize: 13, textAlign: 'center' },
});
