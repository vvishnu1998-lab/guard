/**
 * SiteInstructionsModal — in-app PDF viewer for a site's instructions
 * document.
 *
 * Historically we passed the JWT-scoped GET
 * /api/shifts/:id/instructions.pdf URL + Authorization header directly
 * to <Pdf source={...} />, but react-native-pdf@7.0.4 on Android does
 * not forward the Authorization header to its native PdfRenderer — the
 * request goes out unauthed, gets 401, and surfaces as "Download
 * interrupted". iOS uses a different native path that handles headers
 * correctly.
 *
 * Fix: pre-download the PDF ourselves via react-native-blob-util
 * (uniform header handling across platforms), then hand the local
 * file:// path to <Pdf>. No headers needed for a local file.
 *
 * Errors surface as a retry-or-close panel with a status-specific
 * reason. Full failure (HTTP status + native error stack) lands in
 * Sentry via 'site_instructions.*' breadcrumbs + captureMessage.
 */

import { useEffect, useRef, useState } from 'react';
import {
  View, Text, Modal, TouchableOpacity, ActivityIndicator, StyleSheet,
} from 'react-native';
import Pdf from 'react-native-pdf';
import * as SecureStore from 'expo-secure-store';
import * as Sentry from '@sentry/react-native';
// @ts-expect-error react-native-blob-util ships without types; see backlog
import ReactNativeBlobUtil from 'react-native-blob-util';
import { Colors, Spacing, Radius, Fonts } from '../constants/theme';

interface Props {
  pdfUrl: string;
  visible: boolean;
  onClose: () => void;
}

// Minimal structural types — react-native-blob-util's exported types are
// incomplete/inconsistent across versions, so we type only what we use.
type BlobTask = Promise<BlobResponse> & { cancel: (cb?: () => void) => void };
interface BlobResponse {
  path: () => string;
  info: () => { status: number };
}

const DOWNLOAD_TIMEOUT_MS = 30_000;

function messageForStatus(status: number): string {
  if (status === 401) return 'Session expired. Please log in again.';
  if (status === 404) return 'Instructions not available for this site.';
  if (status === 502 || status === 503 || status === 504) {
    return 'Instructions temporarily unavailable. Please try again.';
  }
  return `Couldn't load instructions (HTTP ${status}).`;
}

export function SiteInstructionsModal({ pdfUrl, visible, onClose }: Props) {
  const [localPath, setLocalPath] = useState<string | null>(null);
  const [error, setError]         = useState<string | null>(null);
  const [loading, setLoading]     = useState(true);
  const [reloadKey, setReloadKey] = useState(0);

  const taskRef       = useRef<BlobTask | null>(null);
  const cachedFileRef = useRef<string | null>(null);

  useEffect(() => {
    if (!visible) return;

    Sentry.addBreadcrumb({
      category: 'site_instructions',
      message:  'open',
      level:    'info',
      data:     { pdf_url: pdfUrl },
    });

    setError(null);
    setLoading(true);
    setLocalPath(null);

    let cancelled = false;

    (async () => {
      const token = await SecureStore.getItemAsync('guard_access_token');
      if (cancelled) return;
      if (!token) {
        Sentry.addBreadcrumb({
          category: 'site_instructions',
          message:  'error',
          level:    'error',
          data:     { pdf_url: pdfUrl, reason: 'no_token' },
        });
        setError('Not authenticated');
        setLoading(false);
        return;
      }

      Sentry.addBreadcrumb({
        category: 'site_instructions',
        message:  'download.start',
        level:    'info',
        data:     { pdf_url: pdfUrl },
      });

      const start = Date.now();
      let res: BlobResponse;
      try {
        const task = ReactNativeBlobUtil.config({
          fileCache: true,
          appendExt: 'pdf',
          timeout:   DOWNLOAD_TIMEOUT_MS,
        }).fetch('GET', pdfUrl, {
          Authorization: `Bearer ${token}`,
        }) as unknown as BlobTask;
        taskRef.current = task;
        res = await task;
      } catch (err) {
        if (cancelled) return;
        const message = String((err as { message?: string })?.message ?? err);
        Sentry.addBreadcrumb({
          category: 'site_instructions',
          message:  'download.error',
          level:    'error',
          data:     { pdf_url: pdfUrl, message },
        });
        Sentry.captureMessage('site_instructions: download failed (network)', {
          level: 'error',
          extra: { pdf_url: pdfUrl, message },
        });
        setError("Couldn't reach the server. Check your connection and try again.");
        setLoading(false);
        return;
      }

      if (cancelled) {
        // Modal closed mid-download; drop the file we no longer need.
        ReactNativeBlobUtil.fs.unlink(res.path()).catch(() => {});
        return;
      }

      const path   = res.path();
      const status = res.info().status;

      if (status !== 200) {
        ReactNativeBlobUtil.fs.unlink(path).catch(() => {});
        Sentry.addBreadcrumb({
          category: 'site_instructions',
          message:  'download.error',
          level:    'error',
          data:     { pdf_url: pdfUrl, status },
        });
        Sentry.captureMessage('site_instructions: download failed (http)', {
          level: 'error',
          extra: { pdf_url: pdfUrl, status },
        });
        setError(messageForStatus(status));
        setLoading(false);
        return;
      }

      const stat        = await ReactNativeBlobUtil.fs.stat(path).catch(() => null);
      const size        = stat ? Number(stat.size) : null;
      const duration_ms = Date.now() - start;
      Sentry.addBreadcrumb({
        category: 'site_instructions',
        message:  'download.success',
        level:    'info',
        data:     { pdf_url: pdfUrl, size, duration_ms },
      });

      cachedFileRef.current = path;
      setLocalPath('file://' + path);
    })();

    return () => {
      cancelled = true;
      Sentry.addBreadcrumb({
        category: 'site_instructions',
        message:  'close',
        level:    'info',
        data:     { pdf_url: pdfUrl },
      });
      if (taskRef.current) {
        try { taskRef.current.cancel(() => {}); } catch { /* noop */ }
        taskRef.current = null;
      }
      if (cachedFileRef.current) {
        ReactNativeBlobUtil.fs.unlink(cachedFileRef.current).catch(() => {});
        cachedFileRef.current = null;
      }
    };
  }, [visible, pdfUrl, reloadKey]);

  function handlePdfError(err: object) {
    const message = String((err as { message?: string })?.message ?? err);
    Sentry.addBreadcrumb({
      category: 'site_instructions',
      message:  'render_error',
      level:    'error',
      data:     { pdf_url: pdfUrl, message },
    });
    Sentry.captureMessage('site_instructions: PDF render failed', {
      level: 'error',
      extra: { pdf_url: pdfUrl, message },
    });
    setError("Couldn't load instructions");
    setLoading(false);
  }

  function handleRetry() {
    setError(null);
    setLoading(true);
    setReloadKey((k) => k + 1);
  }

  const source = localPath ? { uri: localPath } : null;

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
