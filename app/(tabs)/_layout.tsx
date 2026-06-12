import { Tabs } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { AppBackground } from '@/components/AppBackground';
import { YLSidebar } from '@/components/YLSidebar';
import { colors } from '@/constants/theme';

/**
 * iPad split-view foundation: persistent 232pt sidebar with the existing
 * Record, Courses, and Settings routes rendered in the detail area.
 */
export default function TabLayout() {
  return (
    <View style={styles.root}>
      <AppBackground />
      <Tabs
        tabBar={(props) => <YLSidebar {...props} />}
        screenOptions={{
          headerShown: false,
          tabBarPosition: 'left',
          sceneStyle: { backgroundColor: 'transparent' },
        }}
      >
        <Tabs.Screen name="index" options={{ title: 'Record' }} />
        <Tabs.Screen name="courses" options={{ title: 'Courses' }} />
        <Tabs.Screen name="settings" options={{ title: 'Settings' }} />
      </Tabs>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.background,
  },
});
