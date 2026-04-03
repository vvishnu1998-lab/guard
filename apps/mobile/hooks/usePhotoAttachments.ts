/**
 * usePhotoAttachments — shared hook for report photo selection + S3 upload.
 * Used by all three report forms. Manages a list of up to maxPhotos attachments.
 */
import { useState } from 'react';
import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import { uploadToS3, UploadResult } from '../lib/uploadToS3';
import { Alert } from 'react-native';

export interface Attachment {
  localUri:   string;
  public_url: string;
  size_kb:    number;
  uploading:  boolean;
  error?:     string;
}

export function usePhotoAttachments(maxPhotos = 3) {
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [pickingPhoto, setPickingPhoto] = useState(false);

  async function addPhoto() {
    if (attachments.length >= maxPhotos) {
      Alert.alert('Limit reached', `Maximum ${maxPhotos} photos per report.`);
      return;
    }

    setPickingPhoto(true);
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        allowsEditing: false,
        quality: 0.9,
      });

      if (result.canceled || !result.assets[0]) return;

      const asset = result.assets[0];

      // Compress to max 800KB / 1080px wide
      const compressed = await ImageManipulator.manipulateAsync(
        asset.uri,
        [{ resize: { width: 1080 } }],
        { compress: 0.8, format: ImageManipulator.SaveFormat.JPEG }
      );

      const placeholder: Attachment = {
        localUri:   compressed.uri,
        public_url: '',
        size_kb:    0,
        uploading:  true,
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
      .map((a) => ({ url: a.public_url, size_kb: a.size_kb }));
  }

  return { attachments, pickingPhoto, addPhoto, removePhoto, allUploaded, toPayload };
}
