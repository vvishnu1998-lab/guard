/**
 * SelfieCapture — reusable front-camera capture + preview flow.
 *
 * Extracted 2026-07-10 from apps/mobile/app/clock-in/step2.tsx and
 * apps/mobile/app/shifts/[id]/handoff-clock-in.tsx. Since the
 * batch/mobile-11 camera rebuild this is a thin wrapper over
 * components/CameraCapture (full-bleed preview, instant shutter feedback,
 * ref-based double-capture lock); the public API is unchanged so the two
 * callers and step4's SelfieProof consumers don't move.
 *
 * Behavior preserved:
 *  - front camera, capture → preview → retake / use photo
 *  - 1080px / JPEG 0.8 compress, EXIF-stripped (in CameraCapture)
 *  - GPS tag: cached last-known first, live-with-3s-timeout fallback,
 *    (0,0) fallback on total miss — SelfieProof coords are non-nullable
 *  - Sentry breadcrumb category chosen by uploadContext, 'selfie:' message
 *    prefix, so existing dashboards keep parsing
 *  - upload and API submission remain the parent's responsibility
 */
import CameraCapture, { CapturedPhoto } from './CameraCapture';

export interface SelfieProof {
  uri:       string;
  latitude:  number;
  longitude: number;
  takenAt:   string;
}

export type SelfieUploadContext = 'clock_in' | 'handoff_clock_in';

interface Props {
  onSelfieCaptured:    (proof: SelfieProof) => void;
  onCancel?:           () => void;
  uploadContext:       SelfieUploadContext;
  primaryButtonLabel?: string;
  cancelButtonLabel?:  string;
  stepLabel?:          string;
  instruction?:        string;
}

// Sentry category matches the pre-extraction breadcrumb dashboards.
function categoryFor(ctx: SelfieUploadContext): string {
  return ctx === 'clock_in' ? 'clock_in_wizard' : 'handoff_clock_in';
}

export default function SelfieCapture({
  onSelfieCaptured,
  onCancel,
  uploadContext,
  primaryButtonLabel = 'USE PHOTO',
  cancelButtonLabel  = 'CANCEL',
  stepLabel,
  instruction,
}: Props) {
  function handleConfirmed(photo: CapturedPhoto): void {
    onSelfieCaptured({
      uri:       photo.uri,
      latitude:  photo.latitude  ?? 0,
      longitude: photo.longitude ?? 0,
      takenAt:   photo.takenAt,
    });
  }

  return (
    <CameraCapture
      facing="front"
      gps="best-effort"
      confirm
      breadcrumbCategory={categoryFor(uploadContext)}
      breadcrumbPrefix="selfie"
      headerTitle={stepLabel}
      instruction={instruction}
      onCaptured={handleConfirmed}
      onCancel={onCancel}
      primaryButtonLabel={primaryButtonLabel}
      cancelButtonLabel={cancelButtonLabel}
      showCornerGuides={false}
    />
  );
}
