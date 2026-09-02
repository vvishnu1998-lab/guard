/**
 * usePhotoAttachments — shared hook for report photo capture + S3 upload.
 * Camera-only: no gallery picker. Each photo is GPS-tagged and timestamped.
 */
import { useState } from 'react';
import * as ImagePicker from 'expo-image-picker';
import { compressImage } from '../lib/compressImage';
import { guardMessage } from '../lib/errorCopy';
import * as Location from 'expo-location';
import { locationSignals, NO_LOCATION_SIGNALS, type LocationSignals } from '../lib/locationSignals';
import { uploadToS3, UploadResult } from '../lib/uploadToS3';
import { Alert } from 'react-native';

export interface Attachment {
  localUri:    string;
  public_url:  string;
  size_kb:     number;
  uploading:   boolean;
  error?:      string;
  latitude?:   number;
  longitude?:  number;
  /** Shadow capture (Wave 1) — recorded and sent, never evaluated. */
  signals?:    LocationSignals;
  captured_at?: string;
}

export function usePhotoAttachments(maxPhotos = 3) {
  const [attachments,  setAttachments]  = useState<Attachment[]>([]);
  const [pickingPhoto, setPickingPhoto] = useState(false);

  async function addPhoto() {
    if (attachments.length >= maxPhotos) {
      Alert.alert('Limit reached', `Maximum ${maxPhotos} photos per report.`);
      return;
    }

    // Request camera permission
    const { status } = await ImagePicker.requestCameraPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permission Required', 'Camera access is needed to take report photos.');
      return;
    }

    setPickingPhoto(true);
    try {
      // Launch camera directly — no gallery option
      const result = await ImagePicker.launchCameraAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        allowsEditing: false,
        quality: 0.9,
      });

      if (result.canceled || !result.assets[0]) return;

      const asset = result.assets[0];
      const captured_at = new Date().toISOString();

      // GPS — cached first for speed, live with 3s timeout as fallback
      let latitude: number | undefined;
      let longitude: number | undefined;
      // Shadow capture (Wave 1) — recorded and sent, never evaluated. The
      // cached-first read below is the stale-coordinate defect and is
      // deliberately unchanged in this wave; these signals are what make it
      // measurable. See lib/locationSignals.ts.
      let signals: LocationSignals = NO_LOCATION_SIGNALS;
      try {
        const cached = await Location.getLastKnownPositionAsync();
        if (cached) {
          latitude  = cached.coords.latitude;
          longitude = cached.coords.longitude;
          signals   = locationSignals(cached);
        } else {
          const live = await Promise.race([
            Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
            new Promise<null>((res) => setTimeout(() => res(null), 3000)),
          ]);
          if (live) {
            latitude  = (live as Location.LocationObject).coords.latitude;
            longitude = (live as Location.LocationObject).coords.longitude;
            signals   = locationSignals(live as Location.LocationObject);
          }
        }
      } catch { /* GPS optional */ }

      // Compress via the shared helper — the SINGLE implementation, also
      // used by components/CameraCapture. It measures the result and throws
      // rather than ever returning the raw capture.
      //
      // This catch used to be EMPTY, which meant a failed compression
      // silently uploaded asset.uri at quality 0.9 with no record of why.
      // Now the photo is simply not added, and the guard is told which one
      // and how big it was. compressImage has already reported the reason
      // to Sentry, so this only owns the guard-facing half.
      let compressed: { uri: string };
      try {
        compressed = await compressImage(asset.uri, 'report');
      } catch (err: any) {
        Alert.alert('Photo Not Added', guardMessage(err, 'That photo could not be processed. Retake it.', 'report.compress'));
        return;
      }

      const placeholder: Attachment = {
        localUri:    compressed.uri,
        public_url:  '',
        size_kb:     0,
        uploading:   true,
        latitude,
        longitude,
        signals,
        captured_at,
      };
      setAttachments((prev) => [...prev, placeholder]);

      // Upload
      let uploadResult: UploadResult;
      try {
        uploadResult = await uploadToS3(compressed.uri, 'report');
      } catch (err: any) {
        setAttachments((prev) =>
          prev.map((a) =>
            a.localUri === compressed.uri
              ? { ...a, uploading: false, error: err.message }
              : a
          )
        );
        Alert.alert('Upload Failed', err.message ?? 'Could not upload photo.');
        return;
      }

      setAttachments((prev) =>
        prev.map((a) =>
          a.localUri === compressed.uri
            ? { ...a, uploading: false, public_url: uploadResult.public_url, size_kb: uploadResult.size_kb }
            : a
        )
      );
    } finally {
      setPickingPhoto(false);
    }
  }

  function removePhoto(localUri: string) {
    setAttachments((prev) => prev.filter((a) => a.localUri !== localUri));
  }

  function allUploaded() {
    return attachments.every((a) => !a.uploading && !a.error && a.public_url);
  }

  function toPayload() {
    return attachments
      .filter((a) => a.public_url)
      .map((a) => ({
        url:         a.public_url,
        size_kb:     a.size_kb,
        latitude:    a.latitude,
        longitude:   a.longitude,
        ...(a.signals ?? {}),
        captured_at: a.captured_at,
      }));
  }

  return { attachments, pickingPhoto, addPhoto, removePhoto, allUploaded, toPayload };
}
