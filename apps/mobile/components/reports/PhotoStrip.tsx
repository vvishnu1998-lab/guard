/**
 * PhotoStrip — wrap-grid of photo thumbnails with add/remove.
 * Used by all three report forms.
 * E2: layout changed from horizontal ScrollView to flexWrap row so the +ADD
 * button is always visible after 4 photos rather than hidden off-screen.
 */
import { View, Text, StyleSheet, TouchableOpacity, Image, ActivityIndicator } from 'react-native';
import type { Attachment } from '../../hooks/usePhotoAttachments';
import { Colors, Spacing, Radius } from '../../constants/theme';

interface Props {
  attachments: Attachment[];
  onAdd:       () => void;
  onRemove:    (uri: string) => void;
  maxPhotos?:  number;
  disabled?:   boolean;
}

export function PhotoStrip({ attachments, onAdd, onRemove, maxPhotos = 3, disabled }: Props) {
  const canAdd = attachments.length < maxPhotos && !disabled;

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.label}>PHOTOS</Text>
        <Text style={styles.count}>{attachments.length}/{maxPhotos}</Text>
      </View>

      {/* E2: wrap grid — no more horizontal scroll, +ADD always visible */}
      <View style={styles.grid}>
        {attachments.map((att) => (
          <View key={att.localUri} style={styles.thumb}>
            <Image source={{ uri: att.localUri }} style={styles.img} resizeMode="cover" />

            {att.uploading && (
              <View style={styles.overlay}>
                <ActivityIndicator color="#FFFFFF" size="small" />
              </View>
            )}

            {att.error && (
              <View style={[styles.overlay, styles.errorOverlay]}>
                <Text style={styles.errorIcon}>!</Text>
              </View>
            )}

            {!att.uploading && (
              <TouchableOpacity style={styles.removeBtn} onPress={() => onRemove(att.localUri)}>
                <Text style={styles.removeText}>×</Text>
              </TouchableOpacity>
            )}
          </View>
        ))}

        {canAdd && (
          <TouchableOpacity style={styles.addBtn} onPress={onAdd}>
            <Text style={styles.addIcon}>+</Text>
            <Text style={styles.addLabel}>ADD</Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}

const THUMB = 90;
const GAP   = 8;

const styles = StyleSheet.create({
  container: { marginBottom: Spacing.lg },
  header:    { flexDirection: 'row', justifyContent: 'space-between', marginBottom: Spacing.sm },
  label:     { color: Colors.muted, fontSize: 11, letterSpacing: 2 },
  count:     { color: Colors.muted, fontSize: 11 },

  // E2: wrap grid instead of horizontal strip
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: GAP,
  },

  thumb: {
    width: THUMB, height: THUMB,
    borderRadius: Radius.sm,
    overflow: 'hidden',
    backgroundColor: Colors.structure,
  },
  img: { width: '100%', height: '100%' },

  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.5)',
    alignItems: 'center', justifyContent: 'center',
  },
  errorOverlay: { backgroundColor: 'rgba(239,68,68,0.6)' },
  errorIcon:    { color: '#FFFFFF', fontSize: 22, fontWeight: 'bold' },

  removeBtn: {
    position: 'absolute', top: 2, right: 2,
    width: 20, height: 20, borderRadius: 10,
    backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center', justifyContent: 'center',
  },
  removeText: { color: '#FFFFFF', fontSize: 14, lineHeight: 18 },

  addBtn: {
    width: THUMB, height: THUMB,
    borderRadius: Radius.sm,
    borderWidth: 1, borderColor: Colors.border,
    borderStyle: 'dashed',
    alignItems: 'center', justifyContent: 'center',
    gap: 2,
  },
  addIcon:  { color: Colors.action, fontSize: 24 },
  addLabel: { color: Colors.muted, fontSize: 10, letterSpacing: 2 },
});
