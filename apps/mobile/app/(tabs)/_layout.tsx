import { Tabs } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Colors } from '../../constants/theme';

type IoniconsName = React.ComponentProps<typeof Ionicons>['name'];

function icon(name: IoniconsName, focused: boolean) {
  return <Ionicons name={focused ? name : `${name}-outline` as IoniconsName} size={22} color={focused ? Colors.action : Colors.muted} />;
}

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
      <Tabs.Screen name="home"     options={{ title: 'HOME',     tabBarIcon: ({ focused }) => icon('home', focused) }} />
      <Tabs.Screen name="reports"  options={{ title: 'REPORTS',  tabBarIcon: ({ focused }) => icon('document-text', focused) }} />
      <Tabs.Screen name="tasks"    options={{ title: 'TASKS',    tabBarIcon: ({ focused }) => icon('checkbox', focused) }} />
      <Tabs.Screen name="schedule" options={{ title: 'SCHEDULE', tabBarIcon: ({ focused }) => icon('calendar', focused) }} />
      <Tabs.Screen name="alerts"   options={{ title: 'ALERTS',   tabBarIcon: ({ focused }) => icon('notifications', focused) }} />
      <Tabs.Screen name="profile"  options={{ title: 'PROFILE',  tabBarIcon: ({ focused }) => icon('person', focused) }} />
    </Tabs>
  );
}
