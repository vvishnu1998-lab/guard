/**
 * usePhotoAttachments — shared hook for report photo capture + S3 upload.
 * Camera-only: no gallery picker. Each photo is GPS-tagged and timestamped.
 */
import { useState } from 'react';
import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import * as Location from 'expo-location';
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
      try {
        const cached = await Location.getLastKnownPositionAsync();
        if (cached) {
          latitude  = cached.coords.latitude;
          longitude = cached.coords.longitude;
        } else {
          const live = await Promise.race([
            Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
            new Promise<null>((res) => setTimeout(() => res(null), 3000)),
          ]);
          if (live) {
            latitude  = (live as Location.LocationObject).coords.latitude;
            longitude = (live as Location.LocationObject).coords.longitude;
          }
        }
      } catch { /* GPS optional */ }

      // Compress to max 1080px / 80% quality
      let compressed: { uri: string } = { uri: asset.uri };
      try {
        const result = await ImageManipulator.manipulateAsync(
          asset.uri,
          [{ resize: { width: 1080 } }],
          { compress: 0.8, format: ImageManipulator.SaveFormat.JPEG }
        );
        if (result?.uri) compressed = result;
      } catch {
        // Use original if compression fails (Expo Go native module mismatch)
      }

      const placeholder: Attachment = {
        localUri:    compressed.uri,
        public_url:  '',
        size_kb:     0,
        uploading:   true,
        latitude,
        longitude,
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
        captured_at: a.captured_at,
      }));
  }

  return { attachments, pickingPhoto, addPhoto, removePhoto, allUploaded, toPayload };
}
