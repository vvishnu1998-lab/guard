/**
 * Root index — renders nothing; route guard in _layout.tsx immediately
 * redirects to /(auth)/login or /(tabs)/home based on auth state.
 */
import { View } from 'react-native';
import { Colors } from '../constants/theme';

export default function Index() {
  return <View style={{ flex: 1, backgroundColor: Colors.structure }} />;
}
