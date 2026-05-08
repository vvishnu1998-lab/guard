import { useEffect, useRef } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Animated,
  Dimensions, TouchableWithoutFeedback,
} from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useDrawerStore } from '../store/drawerStore';
import { useAuthStore } from '../store/authStore';
import { Colors, Fonts, Spacing, Radius } from '../constants/theme';

const SCREEN_WIDTH = Dimensions.get('window').width;
const DRAWER_WIDTH = SCREEN_WIDTH * 0.8;

interface MenuItem {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
  color?: string;
}

export default function DrawerOverlay() {
  const { isOpen, close } = useDrawerStore();
  const { guardId, logout } = useAuthStore();
  const slideAnim = useRef(new Animated.Value(-DRAWER_WIDTH)).current;
  const opacityAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (isOpen) {
      Animated.parallel([
        Animated.spring(slideAnim, {
          toValue: 0,
          useNativeDriver: true,
          tension: 80,
          friction: 12,
        }),
        Animated.timing(opacityAnim, {
          toValue: 1,
          duration: 200,
          useNativeDriver: true,
        }),
      ]).start();
    } else {
      Animated.parallel([
        Animated.timing(slideAnim, {
          toValue: -DRAWER_WIDTH,
          duration: 220,
          useNativeDriver: true,
        }),
        Animated.timing(opacityAnim, {
          toValue: 0,
          duration: 180,
          useNativeDriver: true,
        }),
      ]).start();
    }
  }, [isOpen]);

  // Derive initials from guardId — in real usage the JWT doesn't carry a name,
  // so we show a generic person icon. If guardId is available, show first char.
  const initials = guardId ? guardId.slice(0, 1).toUpperCase() : '?';

  const menuItems: MenuItem[] = [
    {
      icon: 'document-text-outline',
      label: 'Reports',
      onPress: () => { close(); router.push('/(tabs)/reports'); },
    },
    {
      icon: 'checkbox-outline',
      label: 'Tasks',
      onPress: () => { close(); router.push('/(tabs)/tasks'); },
    },
    {
      icon: 'person-outline',
      label: 'Profile',
      onPress: () => { close(); router.push('/(tabs)/profile'); },
    },
    {
      icon: 'lock-closed-outline',
      label: 'Change Password',
      onPress: () => { close(); router.push('/(auth)/change-password'); },
    },
    {
      icon: 'log-out-outline',
      label: 'Sign Out',
      color: Colors.danger,
      onPress: async () => {
        close();
        await logout();
        router.replace('/(auth)/login');
      },
    },
  ];

  if (!isOpen) return null;

  return (
    <View style={StyleSheet.absoluteFillObject} pointerEvents="box-none">
      {/* Backdrop */}
      <TouchableWithoutFeedback onPress={close}>
        <Animated.View style={[styles.backdrop, { opacity: opacityAnim }]} />
      </TouchableWithoutFeedback>

      {/* Drawer panel */}
      <Animated.View
        style={[styles.drawer, { transform: [{ translateX: slideAnim }] }]}
      >
        {/* Close button */}
        <TouchableOpacity style={styles.closeBtn} onPress={close}>
          <Ionicons name="close" size={24} color={Colors.muted} />
        </TouchableOpacity>

        {/* Avatar + identity */}
        <View style={styles.profileSection}>
          <View style={styles.avatarCircle}>
            <Text style={styles.avatarText}>{initials}</Text>
          </View>
          <Text style={styles.guardName}>GUARD</Text>
          <Text style={styles.companyName}>Netra</Text>
        </View>

        {/* Divider */}
        <View style={styles.divider} />

        {/* Menu items */}
        <View style={styles.menuList}>
          {menuItems.map((item, idx) => (
            <View key={item.label}>
              <TouchableOpacity style={styles.menuItem} onPress={item.onPress} activeOpacity={0.7}>
                <Ionicons
                  name={item.icon}
                  size={22}
                  color={item.color ?? Colors.textPrimary}
                  style={styles.menuIcon}
                />
                <Text style={[styles.menuLabel, item.color ? { color: item.color } : {}]}>
                  {item.label}
                </Text>
              </TouchableOpacity>
              {idx < menuItems.length - 1 && <View style={styles.itemDivider} />}
            </View>
          ))}
        </View>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  drawer: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    width: DRAWER_WIDTH,
    backgroundColor: '#0A1628',
    zIndex: 1000,
    paddingTop: 56,
    paddingHorizontal: Spacing.lg,
    paddingBottom: Spacing.xl,
    shadowColor: '#000',
    shadowOffset: { width: 4, height: 0 },
    shadowOpacity: 0.4,
    shadowRadius: 12,
    elevation: 20,
  },
  closeBtn: {
    position: 'absolute',
    top: 52,
    right: Spacing.md,
    padding: Spacing.sm,
  },
  profileSection: {
    alignItems: 'flex-start',
    marginBottom: Spacing.lg,
    marginTop: Spacing.md,
  },
  avatarCircle: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: Colors.action,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Spacing.sm,
  },
  avatarText: {
    fontFamily: Fonts.heading,
    color: '#070D1A',
    fontSize: 24,
    letterSpacing: 1,
  },
  guardName: {
    fontFamily: Fonts.heading,
    color: Colors.textPrimary,
    fontSize: 20,
    letterSpacing: 3,
    marginBottom: 2,
  },
  companyName: {
    color: Colors.muted,
    fontSize: 13,
    letterSpacing: 1,
  },
  divider: {
    height: 1,
    backgroundColor: Colors.border,
    marginBottom: Spacing.md,
  },
  menuList: {
    flex: 1,
  },
  menuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
  },
  menuIcon: {
    marginRight: Spacing.md,
    width: 24,
  },
  menuLabel: {
    color: Colors.textPrimary,
    fontSize: 17,
    fontFamily: Fonts.body,
    letterSpacing: 0.3,
  },
  itemDivider: {
    height: 1,
    backgroundColor: Colors.border,
    opacity: 0.5,
  },
});
