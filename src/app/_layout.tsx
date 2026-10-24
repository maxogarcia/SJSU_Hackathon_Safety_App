import { DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect } from 'react';
import { StatusBar } from 'expo-status-bar';

import { useTheme } from '@/hooks/use-theme';
import { isOnboarded, SessionProvider, useSession } from '@/providers/session';

SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  return (
    <ThemeProvider value={DefaultTheme}>
      <SessionProvider>
        <RootNavigator />
      </SessionProvider>
    </ThemeProvider>
  );
}

function RootNavigator() {
  const { session, profile, isLoading } = useSession();
  const theme = useTheme();

  useEffect(() => {
    if (!isLoading) SplashScreen.hideAsync();
  }, [isLoading]);

  if (isLoading) return null;

  const signedIn = !!session;
  const onboarded = isOnboarded(profile);

  return (
    <>
      <StatusBar style={signedIn ? 'dark' : 'light'} />
      <Stack
        screenOptions={{
          headerShown: false,
          headerTintColor: theme.accent,
          headerTitleStyle: { color: theme.text },
          headerStyle: { backgroundColor: theme.background },
          contentStyle: { backgroundColor: theme.background },
        }}>
        <Stack.Protected guard={!signedIn}>
          <Stack.Screen name="sign-in" />
        </Stack.Protected>

        <Stack.Protected guard={signedIn && !onboarded}>
          <Stack.Screen name="onboarding" />
        </Stack.Protected>

        <Stack.Protected guard={signedIn && onboarded}>
          <Stack.Screen name="(tabs)" />
          <Stack.Screen name="group/[id]" />
          <Stack.Screen name="share/[id]" options={{ headerShown: true, title: 'Stay in touch' }} />
          <Stack.Screen name="admin" options={{ headerShown: true, title: 'Campus safety dashboard' }} />
        </Stack.Protected>
      </Stack>
    </>
  );
}
