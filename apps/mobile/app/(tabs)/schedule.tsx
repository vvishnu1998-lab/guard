/**
 * Schedule Tab — calendar view of guard's shifts.
 * Fetches GET /api/shifts (guard-scoped, returns last 50).
 */
import { useCallback, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView,
  RefreshControl, ActivityIndicator, Dimensions,
} from 'react-native';
import { useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { apiClient } from '../../lib/apiClient';
import { Colors, Spacing, Radius, Fonts } from '../../constants/theme';

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const DAY_CELL_SIZE = Math.floor((SCREEN_WIDTH - 32) / 7);

const WEEKDAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

interface Shift {
  id:               string;
  site_id:          string;
  site_name:        string;
  scheduled_start:  string;
  scheduled_end:    string;
  status:           'scheduled' | 'active' | 'completed' | 'missed';
}

const STATUS_COLOR: Record<string, string> = {
  scheduled: Colors.action,
  active:    Colors.success,
  completed: Colors.muted,
  missed:    Colors.danger,
};

function getDateKey(iso: string) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function isSameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
}

interface CalendarDay {
  date: Date;
  isCurrentMonth: boolean;
}

function getCalendarDays(month: Date): CalendarDay[] {
  const year = month.getFullYear();
  const mon = month.getMonth();
  const firstDay = new Date(year, mon, 1);
  const lastDay = new Date(year, mon + 1, 0);

  const days: CalendarDay[] = [];

  // Days from previous month
  for (let i = 0; i < firstDay.getDay(); i++) {
    const d = new Date(year, mon, -firstDay.getDay() + i + 1);
    days.push({ date: d, isCurrentMonth: false });
  }

  // Days in current month
  for (let d = 1; d <= lastDay.getDate(); d++) {
    days.push({ date: new Date(year, mon, d), isCurrentMonth: true });
  }

  // Days from next month to fill grid
  const remainder = days.length % 7;
  if (remainder > 0) {
    for (let d = 1; d <= 7 - remainder; d++) {
      days.push({ date: new Date(year, mon + 1, d), isCurrentMonth: false });
    }
  }

  return days;
}

function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function duration(start: string, end: string) {
  const h = (new Date(end).getTime() - new Date(start).getTime()) / 3_600_000;
  return `${h.toFixed(1)}h`;
}

export default function ScheduleScreen() {
  const [shifts,      setShifts]      = useState<Shift[]>([]);
  const [loading,     setLoading]     = useState(true);
  const [refreshing,  setRefreshing]  = useState(false);
  const [error,       setError]       = useState<string | null>(null);
  const [currentMonth, setCurrentMonth] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });
  const [selectedDate, setSelectedDate] = useState<Date | null>(new Date());

  async function fetchShifts() {
    try {
      const data = await apiClient.get<Shift[]>('/shifts');
      setShifts(data);
      setError(null);
    } catch (err: any) {
      setError(err?.message ?? 'Could not load schedule');
    }
  }

  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      fetchShifts().finally(() => setLoading(false));
    }, [])
  );

  async function onRefresh() {
    setRefreshing(true);
    await fetchShifts();
    setRefreshing(false);
  }

  function prevMonth() {
    setCurrentMonth(m => new Date(m.getFullYear(), m.getMonth() - 1, 1));
    setSelectedDate(null);
  }

  function nextMonth() {
    setCurrentMonth(m => new Date(m.getFullYear(), m.getMonth() + 1, 1));
    setSelectedDate(null);
  }

  // Build a set of date keys that have shifts
  const shiftDateSet = new Set(shifts.map(s => getDateKey(s.scheduled_start)));

  // Shifts for selected day
  const selectedDayShifts = selectedDate
    ? shifts.filter(s => isSameDay(new Date(s.scheduled_start), selectedDate))
    : [];

  const calendarDays = getCalendarDays(currentMonth);
  const today = new Date();

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.title}>SCHEDULE</Text>
        <View style={styles.monthNav}>
          <TouchableOpacity onPress={prevMonth} style={styles.navBtn}>
            <Ionicons name="chevron-back" size={22} color={Colors.action} />
          </TouchableOpacity>
          <Text style={styles.monthLabel}>
            {MONTHS[currentMonth.getMonth()]} {currentMonth.getFullYear()}
          </Text>
          <TouchableOpacity onPress={nextMonth} style={styles.navBtn}>
            <Ionicons name="chevron-forward" size={22} color={Colors.action} />
          </TouchableOpacity>
        </View>
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
      ) : (
        <ScrollView
          style={styles.scroll}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.action} />
          }
        >
          {/* Weekday labels */}
          <View style={styles.weekdayRow}>
            {WEEKDAYS.map(d => (
              <View key={d} style={styles.weekdayCell}>
                <Text style={styles.weekdayLabel}>{d}</Text>
              </View>
            ))}
          </View>

          {/* Calendar grid */}
          <View style={styles.calendarGrid}>
            {calendarDays.map((cell, idx) => {
              const key = getDateKey(cell.date.toISOString());
              const hasShift = shiftDateSet.has(key);
              const isToday = isSameDay(cell.date, today);
              const isSelected = selectedDate ? isSameDay(cell.date, selectedDate) : false;

              return (
                <TouchableOpacity
                  key={idx}
                  style={styles.dayCell}
                  onPress={() => cell.isCurrentMonth ? setSelectedDate(cell.date) : undefined}
                  activeOpacity={cell.isCurrentMonth ? 0.7 : 1}
                >
                  <View style={[
                    styles.dayInner,
                    isSelected && styles.daySelected,
                    isToday && !isSelected && styles.dayToday,
                  ]}>
                    <Text style={[
                      styles.dayNum,
                      !cell.isCurrentMonth && styles.dayNumOtherMonth,
                      isSelected && styles.dayNumSelected,
                      isToday && !isSelected && styles.dayNumToday,
                    ]}>
                      {cell.date.getDate()}
                    </Text>
                  </View>
                  {hasShift && cell.isCurrentMonth && (
                    <View style={styles.shiftDot} />
                  )}
                </TouchableOpacity>
              );
            })}
          </View>

          {/* Selected day shifts */}
          <View style={styles.shiftListSection}>
            {selectedDate ? (
              <>
                <Text style={styles.selectedDayTitle}>
                  {selectedDate.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }).toUpperCase()}
                </Text>
                {selectedDayShifts.length === 0 ? (
                  <Text style={styles.noShiftText}>No shift this day</Text>
                ) : (
                  selectedDayShifts.map(shift => {
                    const color = STATUS_COLOR[shift.status] ?? Colors.muted;
                    return (
                      <View key={shift.id} style={[styles.shiftCard, { borderLeftColor: color }]}>
                        <View style={styles.shiftCardRow}>
                          <View style={{ flex: 1 }}>
                            <Text style={styles.siteName}>{shift.site_name.toUpperCase()}</Text>
                            <Text style={styles.shiftTime}>
                              {fmtTime(shift.scheduled_start)} — {fmtTime(shift.scheduled_end)}
                              {'  ·  '}{duration(shift.scheduled_start, shift.scheduled_end)}
                            </Text>
                          </View>
                          <View style={[styles.statusBadge, { borderColor: color }]}>
                            <Text style={[styles.statusText, { color }]}>
                              {shift.status.toUpperCase()}
                            </Text>
                          </View>
                        </View>
                      </View>
                    );
                  })
                )}
              </>
            ) : (
              <Text style={styles.noShiftText}>Tap a day to see shifts</Text>
            )}
          </View>

          <View style={{ height: 32 }} />
        </ScrollView>
      )}
    </View>
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
    gap: Spacing.sm,
  },
  title: {
    fontFamily: Fonts.heading,
    color: Colors.textPrimary,
    fontSize: 24,
    letterSpacing: 4,
  },
  monthNav: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  navBtn: { padding: Spacing.xs },
  monthLabel: {
    fontFamily: Fonts.heading,
    color: Colors.textPrimary,
    fontSize: 18,
    letterSpacing: 2,
  },

  scroll: { flex: 1, paddingHorizontal: 16 },

  weekdayRow: {
    flexDirection: 'row',
    paddingTop: Spacing.md,
    marginBottom: 4,
  },
  weekdayCell: {
    width: DAY_CELL_SIZE,
    alignItems: 'center',
  },
  weekdayLabel: {
    color: Colors.muted,
    fontSize: 11,
    letterSpacing: 1,
    fontFamily: Fonts.heading,
  },

  calendarGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  dayCell: {
    width: DAY_CELL_SIZE,
    height: 48,
    alignItems: 'center',
    justifyContent: 'flex-start',
    paddingTop: 2,
  },
  dayInner: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
  },
  daySelected: {
    backgroundColor: Colors.action,
  },
  dayToday: {
    borderWidth: 1.5,
    borderColor: Colors.action,
  },
  dayNum: {
    color: Colors.textPrimary,
    fontSize: 15,
  },
  dayNumOtherMonth: {
    color: Colors.muted,
    opacity: 0.35,
  },
  dayNumSelected: {
    color: '#070D1A',
    fontFamily: Fonts.heading,
  },
  dayNumToday: {
    color: Colors.action,
    fontFamily: Fonts.heading,
  },
  shiftDot: {
    width: 5,
    height: 5,
    borderRadius: 2.5,
    backgroundColor: Colors.action,
    marginTop: 1,
  },

  shiftListSection: {
    paddingTop: Spacing.lg,
  },
  selectedDayTitle: {
    fontFamily: Fonts.heading,
    color: Colors.muted,
    fontSize: 12,
    letterSpacing: 2,
    marginBottom: Spacing.sm,
  },
  noShiftText: {
    color: Colors.muted,
    fontSize: 14,
    textAlign: 'center',
    paddingVertical: Spacing.lg,
  },
  shiftCard: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.border,
    borderLeftWidth: 3,
    padding: Spacing.md,
    marginBottom: Spacing.sm,
  },
  shiftCardRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  siteName: {
    fontFamily: Fonts.heading,
    color: Colors.textPrimary,
    fontSize: 16,
    letterSpacing: 2,
    marginBottom: 2,
  },
  shiftTime: {
    color: Colors.muted,
    fontSize: 13,
  },
  statusBadge: {
    borderWidth: 1,
    borderRadius: Radius.xs,
    paddingHorizontal: Spacing.sm,
    paddingVertical: 2,
  },
  statusText: {
    fontSize: 10,
    letterSpacing: 1,
    fontFamily: Fonts.heading,
  },

  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: Spacing.xl },
  errorText: { color: Colors.textPrimary, fontSize: 15, textAlign: 'center', marginBottom: Spacing.lg },
  retryBtn: { backgroundColor: Colors.action, borderRadius: Radius.md, padding: Spacing.md },
  retryText: { fontFamily: Fonts.heading, color: '#070D1A', fontSize: 14, letterSpacing: 2 },
});
