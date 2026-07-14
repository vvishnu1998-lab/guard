/**
 * SiteInstructionsModal — in-app PDF viewer for a site's instructions
 * document. Replaces the Build ≤37 Linking.openURL flow which handed
 * the guard off to the OS browser with a public S3 URL (bucket went
 * private post-lockdown, so those URLs now 403).
 *
 * The pdfUrl prop comes straight from the server's
 * shifts.instructions_pdf_url wire field, which now points at the
 * JWT-scoped GET /api/shifts/:id/instructions.pdf endpoint (Build 38
 * API #1 + followup). We attach the guard's Bearer token in the Pdf
 * source headers so the server auth layer accepts the request.
 *
 * Errors surfaced to the guard as a retry-or-close panel with the
 * short server-side reason. The full failure — including native
 * error stack — lands in Sentry via the 'site_instructions.error'
 * breadcrumb + captureMessage.
 */

import { useEffect, useState } from 'react';
import {
  View, Text, Modal, TouchableOpacity, ActivityIndicator, StyleSheet,
} from 'react-native';
import Pdf from 'react-native-pdf';
import * as SecureStore from 'expo-secure-store';
import * as Sentry from '@sentry/react-native';
import { Colors, Spacing, Radius, Fonts } from '../constants/theme';

interface Props {
  pdfUrl: string;
  visible: boolean;
  onClose: () => void;
}

export function SiteInstructionsModal({ pdfUrl, visible, onClose }: Props) {
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Bump to force a fresh mount of <Pdf> for retry — the library caches
  // per-source and a bare state reset won't re-fetch.
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!visible) return;

    Sentry.addBreadcrumb({
      category: 'site_instructions',
      message: 'open',
      level: 'info',
      data: { pdf_url: pdfUrl },
    });

    setError(null);
    setLoading(true);
    setToken(null);

    SecureStore.getItemAsync('guard_access_token').then((t) => {
      if (!t) {
        Sentry.addBreadcrumb({
          category: 'site_instructions',
          message: 'error',
          level: 'error',
          data: { pdf_url: pdfUrl, reason: 'no_token' },
        });
        setError('Not authenticated');
        setLoading(false);
        return;
      }
      setToken(t);
    });

    return () => {
      Sentry.addBreadcrumb({
        category: 'site_instructions',
        message: 'close',
        level: 'info',
        data: { pdf_url: pdfUrl },
      });
    };
  }, [visible, pdfUrl, reloadKey]);

  const source = token
    ? {
        uri: pdfUrl,
        headers: { Authorization: `Bearer ${token}` },
        cache: true,
      }
    : null;

  function handlePdfError(err: object) {
    const message = String((err as { message?: string })?.message ?? err);
    Sentry.addBreadcrumb({
      category: 'site_instructions',
      message: 'error',
      level: 'error',
      data: { pdf_url: pdfUrl, message },
    });
    Sentry.captureMessage('site_instructions: PDF load failed', {
      level: 'error',
      extra: { pdf_url: pdfUrl, message },
    });
    setError(message);
    setLoading(false);
  }

  function handleRetry() {
    setError(null);
    setLoading(true);
    setReloadKey((k) => k + 1);
  }

  return (
    <Modal
      visible={visible}
      animationType="slide"
      onRequestClose={onClose}
    >
      <View style={styles.container}>
        <View style={styles.header}>
          <Text style={styles.title}>SITE INSTRUCTIONS</Text>
          <TouchableOpacity onPress={onClose} style={styles.closeBtn} accessibilityLabel="Close instructions">
            <Text style={styles.closeText}>CLOSE</Text>
          </TouchableOpacity>
        </View>

        {source && !error ? (
          <Pdf
            key={reloadKey}
            source={source}
            style={styles.pdf}
            onLoadComplete={() => setLoading(false)}
            onError={handlePdfError}
            enablePaging={false}
            enableAnnotationRendering={false}
            trustAllCerts={false}
          />
        ) : null}

        {loading && !error ? (
          <View style={styles.centerOverlay} pointerEvents="none">
            <ActivityIndicator color={Colors.action} size="large" />
            <Text style={styles.loadingText}>LOADING INSTRUCTIONS…</Text>
          </View>
        ) : null}

        {error ? (
          <View style={styles.center}>
            <Text style={styles.errorIcon}>⚠️</Text>
            <Text style={styles.errorTitle}>COULDN'T LOAD INSTRUCTIONS</Text>
            <Text style={styles.errorMsg} numberOfLines={3}>{error}</Text>
            <TouchableOpacity style={styles.retryBtn} onPress={handleRetry}>
              <Text style={styles.retryText}>RETRY</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.dismissBtn} onPress={onClose}>
              <Text style={styles.dismissText}>DISMISS</Text>
            </TouchableOpacity>
          </View>
        ) : null}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.structure },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.lg,
    paddingTop: 60,
    paddingBottom: Spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
    backgroundColor: Colors.surface,
  },
  title: {
    fontFamily: Fonts.heading,
    color: Colors.base,
    fontSize: 16,
    letterSpacing: 3,
  },
  closeBtn: {
    paddingVertical: Spacing.xs,
    paddingHorizontal: Spacing.md,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: Radius.md,
  },
  closeText: {
    fontFamily: Fonts.heading,
    color: Colors.base,
    fontSize: 12,
    letterSpacing: 2,
  },

  pdf: { flex: 1, backgroundColor: Colors.structure },

  centerOverlay: {
    position: 'absolute',
    top: 0, left: 0, right: 0, bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.structure,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: Spacing.xl,
  },
  loadingText: {
    color: Colors.muted,
    fontSize: 12,
    letterSpacing: 2,
    marginTop: Spacing.md,
  },
  errorIcon:  { fontSize: 44, marginBottom: Spacing.md },
  errorTitle: {
    fontFamily: Fonts.heading,
    color: Colors.base,
    fontSize: 16,
    letterSpacing: 3,
    marginBottom: Spacing.sm,
    textAlign: 'center',
  },
  errorMsg: {
    color: Colors.muted,
    fontSize: 13,
    lineHeight: 18,
    textAlign: 'center',
    marginBottom: Spacing.xl,
  },
  retryBtn: {
    backgroundColor: Colors.action,
    borderRadius: Radius.md,
    paddingVertical: Spacing.md,
    paddingHorizontal: Spacing.xl,
    marginBottom: Spacing.sm,
    minWidth: 160,
    alignItems: 'center',
  },
  retryText: {
    fontFamily: Fonts.heading,
    color: Colors.structure,
    fontSize: 14,
    letterSpacing: 2,
  },
  dismissBtn: { padding: Spacing.sm },
  dismissText: { color: Colors.muted, fontSize: 13, letterSpacing: 2 },
});
