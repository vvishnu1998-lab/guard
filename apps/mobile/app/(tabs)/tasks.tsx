/**
 * Tasks Tab — guard's task list for the current shift.
 * Groups instances into PENDING (sorted by due_at) and COMPLETED.
 * Reloads on tab focus so completions are reflected immediately.
 */
import { useCallback, useState } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity,
  RefreshControl, ActivityIndicator,
} from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { useShiftStore } from '../../store/shiftStore';
import { apiClient }     from '../../lib/apiClient';
import { Colors, Spacing, Radius, Fonts } from '../../constants/theme';

interface TaskInstance {
  id:                   string;
  title:                string;
  template_description: string | null;
  due_at:               string | null;
  status:               'pending' | 'completed';
  requires_photo:       boolean;
  completed_at:         string | null;
  completion_photo:     string | null;
  completion_lat:       number | null;
  completion_lng:       number | null;
}

export default function TasksScreen() {
  const [tasks,      setTasks]      = useState<TaskInstance[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error,      setError]      = useState<string | null>(null);

  const { activeShift } = useShiftStore();

  async function fetchTasks() {
    if (!activeShift) {
      setTasks([]);
      setLoading(false);
      return;
    }
    try {
      const res = await apiClient(`/api/tasks/instances?shift_id=${activeShift.id}`);
      if (!res.ok) throw new Error('Failed to load tasks');
      setTasks(await res.json());
      setError(null);
    } catch (err: any) {
      setError(err?.message ?? 'Could not load tasks');
    }
  }

  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      fetchTasks().finally(() => setLoading(false));
    }, [activeShift?.id])
  );

  async function onRefresh() {
    setRefreshing(true);
    await fetchTasks();
    setRefreshing(false);
  }

  const pending   = tasks.filter((t) => t.status === 'pending');
  const completed = tasks.filter((t) => t.status === 'completed');

  function fmtTime(iso: string | null) {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function isOverdue(dueAt: string | null) {
    if (!dueAt) return false;
    return new Date(dueAt) < new Date();
  }

  function renderTask(item: TaskInstance) {
    const overdue    = item.status === 'pending' && isOverdue(item.due_at);
    const borderClr  = item.status === 'completed' ? '#22C55E' : overdue ? '#EF4444' : Colors.border;

    return (
      <TouchableOpacity
        key={item.id}
        style={[styles.card, { borderColor: borderClr }]}
        onPress={() => item.status === 'pending' && router.push(`/tasks/complete/${item.id}`)}
        disabled={item.status === 'completed'}
        activeOpacity={item.status === 'completed' ? 1 : 0.7}
      >
        <View style={styles.cardTop}>
          <View style={[
            styles.statusDot,
            { backgroundColor: item.status === 'completed' ? '#22C55E' : overdue ? '#EF4444' : Colors.muted }
          ]} />
          <Text style={[styles.taskTitle, item.status === 'completed' && styles.completedTitle]}>
            {item.title}
          </Text>
          {item.requires_photo && (
            <Text style={styles.photoTag}>📷</Text>
          )}
        </View>

        {item.template_description ? (
          <Text style={styles.taskDesc} numberOfLines={1}>{item.template_description}</Text>
        ) : null}

        <View style={styles.cardBottom}>
          {item.status === 'pending' ? (
            <>
              <Text style={[styles.dueText, overdue && styles.overdueText]}>
                {overdue ? '⚠ OVERDUE' : 'DUE'} {fmtTime(item.due_at)}
              </Text>
              <Text style={styles.tapText}>TAP TO COMPLETE →</Text>
            </>
          ) : (
            <Text style={styles.completedText}>
              ✓ COMPLETED {fmtTime(item.completed_at)}
            </Text>
          )}
        </View>
      </TouchableOpacity>
    );
  }

  if (!activeShift) {
    return (
      <View style={styles.center}>
        <Text style={styles.noShiftIcon}>⏸</Text>
        <Text style={styles.noShiftText}>No active shift</Text>
        <Text style={styles.noShiftSub}>Tasks are generated when you clock in</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.title}>TASKS</Text>
        <Text style={styles.subtitle}>{activeShift.site_name?.toUpperCase()}</Text>
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={Colors.action} size="large" />
        </View>
      ) : error ? (
        <View style={styles.center}>
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity style={styles.retryBtn} onPress={onRefresh}>
            <Text style={styles.retryText}>RETRY</Text>
          </TouchableOpacity>
        </View>
      ) : tasks.length === 0 ? (
        <View style={styles.center}>
          <Text style={styles.noShiftIcon}>✅</Text>
          <Text style={styles.noShiftText}>No tasks for this shift</Text>
          <Text style={styles.noShiftSub}>Ask your admin to create task templates</Text>
        </View>
      ) : (
        <FlatList
          data={[...pending, ...completed]}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => renderTask(item)}
          contentContainerStyle={styles.listContent}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.action} />
          }
          ListHeaderComponent={
            <>
              {pending.length > 0 && (
                <View style={styles.sectionHeader}>
                  <Text style={styles.sectionLabel}>PENDING</Text>
                  <Text style={styles.sectionCount}>{pending.length}</Text>
                </View>
              )}
            </>
          }
          ItemSeparatorComponent={() => <View style={{ height: Spacing.sm }} />}
          // Insert "COMPLETED" section header before first completed item
          ListFooterComponent={
            completed.length > 0 ? (
              <View style={styles.sectionHeader}>
                <Text style={[styles.sectionLabel, { color: '#22C55E' }]}>COMPLETED</Text>
                <Text style={styles.sectionCount}>{completed.length}</Text>
              </View>
            ) : null
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.structure },

  header: {
    paddingHorizontal: Spacing.xl,
    paddingTop: 60, paddingBottom: Spacing.md,
    borderBottomWidth: 1, borderBottomColor: Colors.border,
  },
  title:    { fontFamily: Fonts.heading, color: Colors.base, fontSize: 24, letterSpacing: 4 },
  subtitle: { color: Colors.action, fontSize: 11, letterSpacing: 3, marginTop: 2 },

  listContent: { padding: Spacing.md },

  sectionHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: Spacing.sm, paddingHorizontal: 2, marginBottom: Spacing.sm,
  },
  sectionLabel: { color: Colors.muted, fontSize: 11, letterSpacing: 3 },
  sectionCount: {
    backgroundColor: Colors.surface, borderRadius: Radius.full,
    paddingHorizontal: Spacing.sm, paddingVertical: 2,
    color: Colors.muted, fontSize: 11,
  },

  card: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    borderWidth: 1,
    padding: Spacing.md,
  },
  cardTop: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, marginBottom: 4 },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  taskTitle:     { flex: 1, color: Colors.base, fontSize: 15, fontFamily: Fonts.heading, letterSpacing: 1 },
  completedTitle:{ color: Colors.muted },
  photoTag:      { fontSize: 14 },
  taskDesc:      { color: Colors.muted, fontSize: 12, marginBottom: Spacing.sm },

  cardBottom:    { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: Spacing.sm },
  dueText:       { color: Colors.muted, fontSize: 11, letterSpacing: 1 },
  overdueText:   { color: '#EF4444' },
  tapText:       { color: Colors.action, fontSize: 11, letterSpacing: 1 },
  completedText: { color: '#22C55E', fontSize: 11, letterSpacing: 1 },

  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: Spacing.xl },
  noShiftIcon: { fontSize: 48, marginBottom: Spacing.md },
  noShiftText: { color: Colors.base, fontSize: 18, marginBottom: Spacing.xs },
  noShiftSub:  { color: Colors.muted, fontSize: 13, textAlign: 'center' },

  errorText: { color: Colors.base, fontSize: 15, textAlign: 'center', marginBottom: Spacing.lg },
  retryBtn:  { backgroundColor: Colors.action, borderRadius: Radius.md, padding: Spacing.md },
  retryText: { fontFamily: Fonts.heading, color: Colors.structure, fontSize: 14, letterSpacing: 2 },
});
