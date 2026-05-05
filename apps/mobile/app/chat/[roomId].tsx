/**
 * Guard — Chat room screen
 * Message thread with guard on right (cyan), admin on left (surface).
 * 10-second polling. Enter to send (keyboard submit).
 * FCM tap: if notification data.type === 'chat' and data.roomId, navigate here.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, FlatList,
  TextInput, KeyboardAvoidingView, Platform, ActivityIndicator,
} from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { apiClient } from '../../lib/apiClient';
import { Colors, Spacing, Radius, Fonts } from '../../constants/theme';

interface ChatMessage {
  id:          string;
  room_id:     string;
  sender_role: 'admin' | 'guard';
  sender_id:   string;
  message:     string;
  created_at:  string;
}

export default function ChatRoomScreen() {
  const { roomId } = useLocalSearchParams<{ roomId: string }>();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading,  setLoading]  = useState(true);
  const [text,     setText]     = useState('');
  const [sending,  setSending]  = useState(false);
  const [error,    setError]    = useState('');

  const listRef  = useRef<FlatList>(null);
  const pollRef  = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadMessages = useCallback(async (silent = false) => {
    if (!roomId) return;
    if (!silent) setLoading(true);
    try {
      const data = await apiClient.get<ChatMessage[]>(`/chat/rooms/${roomId}/messages`);
      setMessages(data);
      setError('');
    } catch (e: any) {
      if (!silent) setError(e?.message ?? 'Failed to load messages');
    } finally {
      if (!silent) setLoading(false);
    }
  }, [roomId]);

  useEffect(() => {
    loadMessages();
    pollRef.current = setInterval(() => loadMessages(true), 10000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [loadMessages]);

  // Scroll to end when messages change
  useEffect(() => {
    if (messages.length > 0) {
      setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 100);
    }
  }, [messages.length]);

  async function sendMessage() {
    if (!text.trim() || sending || !roomId) return;
    const body = text.trim();
    setSending(true);
    setText('');
    try {
      const msg = await apiClient.post<ChatMessage>(`/chat/rooms/${roomId}/messages`, { message: body });
      setMessages((prev) => [...prev, msg]);
    } catch (e: any) {
      setError(e?.message ?? 'Failed to send');
      setText(body);
    } finally {
      setSending(false);
    }
  }

  function renderMessage({ item }: { item: ChatMessage }) {
    const isGuard = item.sender_role === 'guard';
    return (
      <View style={[styles.msgRow, isGuard ? styles.msgRowRight : styles.msgRowLeft]}>
        <View style={[styles.bubble, isGuard ? styles.bubbleGuard : styles.bubbleAdmin]}>
          <Text style={[styles.msgText, isGuard ? styles.msgTextGuard : styles.msgTextAdmin]}>
            {item.message}
          </Text>
          <Text style={[styles.msgTime, isGuard ? styles.msgTimeGuard : styles.msgTimeAdmin]}>
            {new Date(item.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </Text>
        </View>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={0}
    >
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={24} color={Colors.action} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>CHAT</Text>
        <View style={{ width: 40 }} />
      </View>

      {error ? (
        <View style={styles.center}>
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity onPress={() => loadMessages()} style={styles.retryBtn}>
            <Text style={styles.retryText}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : loading ? (
        <ActivityIndicator color={Colors.action} style={{ marginTop: Spacing.xl }} />
      ) : (
        <FlatList
          ref={listRef}
          data={messages}
          keyExtractor={(item) => item.id}
          renderItem={renderMessage}
          contentContainerStyle={styles.msgList}
          showsVerticalScrollIndicator={false}
          ListEmptyComponent={
            <View style={styles.center}>
              <Text style={styles.emptyText}>No messages yet. Say hello!</Text>
            </View>
          }
          onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: false })}
        />
      )}

      {/* Input */}
      <View style={styles.inputRow}>
        <TextInput
          value={text}
          onChangeText={setText}
          placeholder="Type a message…"
          placeholderTextColor={Colors.muted}
          style={styles.input}
          multiline
          maxLength={500}
          onSubmitEditing={sendMessage}
          blurOnSubmit={false}
          returnKeyType="send"
        />
        <TouchableOpacity
          onPress={sendMessage}
          disabled={sending || !text.trim()}
          style={[styles.sendBtn, (sending || !text.trim()) && styles.sendBtnDisabled]}
          activeOpacity={0.8}
        >
          {sending ? (
            <ActivityIndicator color={Colors.bg} size="small" />
          ) : (
            <Ionicons name="send" size={18} color={Colors.bg} />
          )}
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: 54,
    paddingBottom: Spacing.sm,
    paddingHorizontal: Spacing.md,
    backgroundColor: Colors.bg,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  backBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  headerTitle: {
    fontFamily: Fonts.heading,
    color: Colors.action,
    fontSize: 20,
    letterSpacing: 4,
  },

  msgList: { paddingHorizontal: Spacing.md, paddingVertical: Spacing.md, paddingBottom: Spacing.lg },

  msgRow: { marginBottom: Spacing.sm, flexDirection: 'row' },
  msgRowLeft:  { justifyContent: 'flex-start' },
  msgRowRight: { justifyContent: 'flex-end' },

  bubble: {
    maxWidth: '75%',
    borderRadius: Radius.lg,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
  },
  bubbleGuard: {
    backgroundColor: Colors.action,
    borderBottomRightRadius: Radius.xs,
  },
  bubbleAdmin: {
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    borderBottomLeftRadius: Radius.xs,
  },
  msgText: { fontSize: 14, lineHeight: 20 },
  msgTextGuard: { color: Colors.bg },
  msgTextAdmin: { color: Colors.textPrimary },
  msgTime: { fontSize: 10, marginTop: 3 },
  msgTimeGuard: { color: Colors.bg + 'AA' },
  msgTimeAdmin: { color: Colors.muted },

  inputRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: Spacing.sm,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    paddingBottom: Platform.OS === 'ios' ? 28 : Spacing.sm,
    borderTopWidth: 1,
    borderTopColor: Colors.border,
    backgroundColor: Colors.bg,
  },
  input: {
    flex: 1,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: Radius.lg,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    color: Colors.textPrimary,
    fontSize: 14,
    maxHeight: 120,
    minHeight: 44,
  },
  sendBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: Colors.action,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendBtnDisabled: { opacity: 0.4 },

  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: Spacing.xl },
  emptyText: { color: Colors.muted, fontSize: 14, textAlign: 'center' },
  errorText: { color: Colors.danger, fontSize: 14, marginBottom: Spacing.sm, textAlign: 'center' },
  retryBtn: { padding: Spacing.sm },
  retryText: { color: Colors.action, fontSize: 14 },
});
