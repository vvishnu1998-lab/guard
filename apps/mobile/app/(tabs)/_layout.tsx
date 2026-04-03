import { Tabs } from 'expo-router';
import { Colors } from '../../constants/theme';

export default function TabLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: { backgroundColor: Colors.structure, borderTopColor: Colors.border },
        tabBarActiveTintColor: Colors.action,
        tabBarInactiveTintColor: Colors.muted,
        tabBarLabelStyle: { fontSize: 10, letterSpacing: 1 },
      }}
    >
      <Tabs.Screen name="home" options={{ title: 'HOME' }} />
      <Tabs.Screen name="reports" options={{ title: 'REPORTS' }} />
      <Tabs.Screen name="tasks" options={{ title: 'TASKS' }} />
      <Tabs.Screen name="schedule" options={{ title: 'SCHEDULE' }} />
      <Tabs.Screen name="alerts" options={{ title: 'ALERTS' }} />
      <Tabs.Screen name="profile" options={{ title: 'PROFILE' }} />
    </Tabs>
  );
}
