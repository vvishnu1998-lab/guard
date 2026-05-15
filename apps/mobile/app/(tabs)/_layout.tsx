import { View } from 'react-native';
import { Tabs } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import DrawerOverlay from '../../components/DrawerOverlay';
import { useUnreadStore } from '../../store/unreadStore';

type IoniconsName = React.ComponentProps<typeof Ionicons>['name'];

const ACTIVE_COLOR = '#00C8FF';
const INACTIVE_COLOR = '#445566';

function TabIcon(name: IoniconsName, focused: boolean) {
  return (
    <Ionicons
      name={focused ? name : (`${name}-outline` as IoniconsName)}
      size={26}
      color={focused ? ACTIVE_COLOR : INACTIVE_COLOR}
    />
  );
}

export default function TabLayout() {
  const notificationUnread = useUnreadStore((s) => s.notificationUnread);
  const chatUnread         = useUnreadStore((s) => s.chatUnread);

  return (
    <View style={{ flex: 1 }}>
      <Tabs
        screenOptions={{
          headerShown: false,
          tabBarStyle: {
            backgroundColor: '#070D1A',
            borderTopColor: '#1E3A5F',
            borderTopWidth: 1,
            height: 68,
            paddingBottom: 8,
            paddingTop: 6,
          },
          tabBarActiveTintColor: ACTIVE_COLOR,
          tabBarInactiveTintColor: INACTIVE_COLOR,
          tabBarLabelStyle: {
            fontSize: 11,
            letterSpacing: 1.5,
          },
        }}
      >
        {/* Visible tabs */}
        <Tabs.Screen
          name="home"
          options={{
            title: 'HOME',
            tabBarIcon: ({ focused }) => TabIcon('home', focused),
          }}
        />
        <Tabs.Screen
          name="schedule"
          options={{
            title: 'SCHEDULE',
            tabBarIcon: ({ focused }) => TabIcon('calendar', focused),
          }}
        />
        <Tabs.Screen
          name="notifications"
          options={{
            title: 'ALERTS',
            tabBarIcon: ({ focused }) => TabIcon('notifications', focused),
            tabBarBadge: notificationUnread > 0 ? notificationUnread : undefined,
            tabBarBadgeStyle: {
              backgroundColor: '#FF5C5C',
              color: '#FFFFFF',
              fontSize: 11,
            },
          }}
        />

        <Tabs.Screen
          name="chat"
          options={{
            title: 'CHAT',
            tabBarIcon: ({ focused }) => TabIcon('chatbubbles', focused),
            tabBarBadge: chatUnread > 0 ? chatUnread : undefined,
            tabBarBadgeStyle: {
              backgroundColor: '#FF5C5C',
              color: '#FFFFFF',
              fontSize: 11,
            },
          }}
        />

        {/* Hidden — accessible via router.push but not shown in tab bar */}
        <Tabs.Screen name="reports"  options={{ href: null }} />
        <Tabs.Screen name="tasks"    options={{ href: null }} />
        <Tabs.Screen name="alerts"   options={{ href: null }} />
        <Tabs.Screen name="profile"  options={{ href: null }} />
      </Tabs>

      <DrawerOverlay />
    </View>
  );
}
