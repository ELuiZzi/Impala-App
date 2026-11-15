import { Stack } from 'expo-router';
import { useThemeColor } from '@/components/theme';

export default function BibliotecaLayout() {
  const background = useThemeColor('background');
  return <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: background } }} />;
}
