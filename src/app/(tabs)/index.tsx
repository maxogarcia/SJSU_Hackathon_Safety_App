// Walk planner (design: "Home / map" frame). Choose a meetup point and destination, fetch a walking
// route, then create_walk_request + find_or_create_group (matching happens in Postgres, see AGENTS.md).

import { Ionicons } from '@expo/vector-icons';
import * as Location from 'expo-location';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Avatar } from '@/components/avatar';
import { Button } from '@/components/button';
import { Chip } from '@/components/chip';
import { ReportSheet } from '@/components/report-sheet';
import { Card, ErrorText, Notice } from '@/components/screen';
import { SafetyBar } from '@/components/safety-bar';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { WalkMap, type MapPin, type MapZone } from '@/components/walk-map';
import { useIncidents } from '@/hooks/use-incidents';
import { useTheme } from '@/hooks/use-theme';
import { MaxContentWidth, Radius, Spacing } from '@/constants/theme';
import { createWalkRequest, findOrCreateGroup, getActiveGroup, listMeetupPoints, type MeetupPoint } from '@/lib/api';
import {
  formatDistance,
  formatDuration,
  toGeoJsonCoordinates,
  type LatLng,
  type WalkingRoute,
} from '@/lib/directions';
import { blockingZones, CATEGORY_LABEL } from '@/lib/safety';
import { routeSafest, type OpenAlongRoute } from '@/lib/liveliness';
import { useSession } from '@/providers/session';

const DEPART_OPTIONS = [
  { label: 'Now', minutes: 0 },
  { label: 'In 15 min', minutes: 15 },
  { label: 'In 30 min', minutes: 30 },
  { label: 'In 1 hr', minutes: 60 },
];

export default function WalkScreen() {
  const theme = useTheme();
  const { profile, refreshProfile } = useSession();
  const [points, setPoints] = useState<MeetupPoint[]>([]);
  const [meetupId, setMeetupId] = useState<string | null>(null);
  const [destination, setDestination] = useState<LatLng | null>(null);
  const [destLabel, setDestLabel] = useState('Dropped pin');
  const [route, setRoute] = useState<WalkingRoute | null>(null);
  const [routeLoading, setRouteLoading] = useState(false);
  const [departIn, setDepartIn] = useState(0);
  const [lively, setLively] = useState<{ open: OpenAlongRoute; brighter: boolean } | null>(null);
  const [activeGroup, setActiveGroup] = useState<string | null>(null);
  const [matching, setMatching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [avoiding, setAvoiding] = useState<string[]>([]);
  const [reportOpen, setReportOpen] = useState(false);
  const { zones, incidents } = useIncidents();

  const verified = profile?.verification_status === 'verified';
  const meetupIndex = points.findIndex((p) => p.id === meetupId);
  const meetup = points[meetupIndex] ?? null;

  useEffect(() => {
    Location.requestForegroundPermissionsAsync().catch(() => {});
    listMeetupPoints()
      .then((list) => {
        setPoints(list);
        setMeetupId((current) => current ?? list[0]?.id ?? null);
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  useFocusEffect(
    useCallback(() => {
      refreshProfile();
      getActiveGroup()
        .then(setActiveGroup)
        .catch(() => setActiveGroup(null));
    }, [refreshProfile])
  );

  // Only the latest route request may update state, in case the user taps around quickly.
  const routeRequest = useRef(0);
  const updateRoute = async (from: MeetupPoint | null, to: LatLng | null) => {
    const requestNo = ++routeRequest.current;
    setRoute(null);
    setAvoiding([]);
    setLively(null);
    if (!from || !to) return;
    setRouteLoading(true);
    try {
      // Plan around anything already reported on the way, preferring streets with open businesses.
      const departAt = new Date(Date.now() + departIn * 60 * 1000);
      const plan = await routeSafest({ latitude: from.lat, longitude: from.lng }, to, zones, departAt);
      if (requestNo === routeRequest.current) {
        setRoute(plan.route);
        setLively({ open: plan.open, brighter: plan.brighter });
        setAvoiding(plan.avoided.map((z) => CATEGORY_LABEL[z.category] ?? z.title));
      }
    } catch (e) {
      if (requestNo === routeRequest.current) setError((e as Error).message);
    } finally {
      if (requestNo === routeRequest.current) setRouteLoading(false);
    }
  };

  const selectMeetup = (id: string) => {
    setMeetupId(id);
    updateRoute(points.find((p) => p.id === id) ?? null, destination);
  };

  const pickDestination = async (coordinate: LatLng) => {
    setDestination(coordinate);
    setDestLabel('Dropped pin');
    setError(null);
    updateRoute(meetup, coordinate);
    try {
      const [place] = await Location.reverseGeocodeAsync(coordinate);
      if (place) setDestLabel([place.streetNumber, place.street].filter(Boolean).join(' ') || place.name || 'Dropped pin');
    } catch {
      // A label is nice to have; the coordinates are what matter.
    }
  };

  const clearDestination = () => {
    routeRequest.current++;
    setDestination(null);
    setRoute(null);
    setAvoiding([]);
    setRouteLoading(false);
  };

  const findBuddies = async () => {
    if (!meetup || !destination || !route) return;
    setMatching(true);
    setError(null);
    try {
      const requestId = await createWalkRequest({
        meetupPointId: meetup.id,
        destLat: destination.latitude,
        destLng: destination.longitude,
        destLabel,
        route: toGeoJsonCoordinates(route.points),
        departAt: minutesFromNow(departIn),
      });
      const groupId = await findOrCreateGroup(requestId);
      router.push({ pathname: '/group/[id]', params: { id: groupId } });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setMatching(false);
    }
  };

  // A new report lands on the route I'm planning: plan again around it.
  const blocked = route ? blockingZones(route.points, zones).map((z) => z.id).join(',') : '';
  useEffect(() => {
    if (!blocked) return;
    const t = setTimeout(() => updateRoute(meetup, destination), 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blocked]);

  const mapZones: MapZone[] = zones.map((z) => ({
    id: z.id,
    latitude: z.lat,
    longitude: z.lng,
    radius: z.radius_m,
    title: z.title,
    description: CATEGORY_LABEL[z.category],
    severity: z.severity,
  }));

  const pins: MapPin[] = [
    ...points.map<MapPin>((p) => ({
      id: p.id,
      title: p.name,
      description: p.description ?? undefined,
      latitude: p.lat,
      longitude: p.lng,
      kind: p.id === meetupId ? 'meetup-selected' : 'meetup',
    })),
    ...(destination ? [{ id: 'destination', title: destLabel, kind: 'destination' as const, ...destination }] : []),
  ];

  return (
    <ThemedView type="backgroundElement" style={styles.flex}>
      <SafeAreaView edges={['top']} style={styles.flex}>
        <View style={styles.head}>
          <View style={styles.flex}>
            <ThemedText style={styles.h1}>Hey, {profile?.first_name ?? 'Spartan'} 👋</ThemedText>
            <ThemedText themeColor="textSecondary">Your next walk starts here.</ThemedText>
          </View>
          <Pressable onPress={() => router.navigate('/profile')}>
            <Avatar path={profile?.avatar_path} name={profile?.first_name} size={40} />
          </Pressable>
        </View>

        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.scroll}>
          <View>
            <WalkMap
              pins={pins}
              route={route?.points}
              zones={mapZones}
              height={330}
              rounded={false}
              onPinPress={(id) => points.some((p) => p.id === id) && selectMeetup(id)}
              onMapPress={pickDestination}
            />
            <View pointerEvents="box-none" style={styles.overlay}>
              <ThemedView type="backgroundElement" style={[styles.search, { shadowColor: theme.text }]}>
                <Ionicons name="search" size={20} color={theme.accent} />
                <View style={styles.flex}>
                  <ThemedText themeColor="textSecondary" style={styles.searchLabel}>
                    WALKING TOWARD
                  </ThemedText>
                  <ThemedText numberOfLines={1} style={styles.searchValue}>
                    {destination ? destLabel : 'Tap the map where you’re headed'}
                  </ThemedText>
                </View>
                {destination && (
                  <ThemedText type="smallBold" themeColor="accent" onPress={clearDestination}>
                    Clear
                  </ThemedText>
                )}
              </ThemedView>
            </View>
          </View>

          <View style={styles.sheet}>
            {activeGroup && (
              <Card>
                <ThemedText type="smallBold" themeColor="accent" style={styles.eyebrow}>
                  ● HEAD TO YOUR MEETUP
                </ThemedText>
                <ThemedText type="small" themeColor="textSecondary">
                  You have a walk in progress.
                </ThemedText>
                <Button
                  title="View your pack"
                  icon="people-outline"
                  onPress={() => router.push({ pathname: '/group/[id]', params: { id: activeGroup } })}
                />
              </Card>
            )}

            {!verified && (
              <Notice icon="hourglass-outline">
                ID verification pending. You can plan a route now; matching with other students unlocks once your ID is
                approved.
              </Notice>
            )}

            <View style={styles.row}>
              <ThemedText type="smallBold" themeColor="accent" style={styles.eyebrow}>
                ● MEETUP POINT
              </ThemedText>
              {route && (
                <ThemedText type="small" themeColor="textSecondary">
                  {formatDuration(route.durationS)} · {formatDistance(route.distanceM)}
                </ThemedText>
              )}
            </View>
            <ThemedText type="small" themeColor="textSecondary">
              Pick a designated meetup spot, then tap the map to set where you&apos;re headed. We&apos;ll look for students
              going a similar way.
            </ThemedText>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
              {points.map((p) => (
                <Chip key={p.id} label={p.is_staffed ? `${p.name} · staffed` : p.name} selected={p.id === meetupId} onPress={() => selectMeetup(p.id)} />
              ))}
            </ScrollView>

            {meetup && (
              <View style={styles.place}>
                <View style={[styles.badge, { backgroundColor: theme.amberSoft }]}>
                  <ThemedText style={[styles.badgeText, { color: theme.navy }]}>{String.fromCharCode(65 + meetupIndex)}</ThemedText>
                </View>
                <View style={styles.flex}>
                  <ThemedText style={styles.placeName}>{meetup.name}</ThemedText>
                  {meetup.description && (
                    <ThemedText type="small" themeColor="textSecondary">
                      {meetup.description}
                    </ThemedText>
                  )}
                </View>
              </View>
            )}

            {destination && (
              <View style={styles.metaRow}>
                <Ionicons name="walk-outline" size={18} color={theme.accent} />
                <ThemedText style={styles.flex}>
                  {routeLoading ? 'Finding a walking route…' : route ? `About ${formatDuration(route.durationS)} to ${destLabel}` : 'No route yet'}
                </ThemedText>
              </View>
            )}
            {lively && lively.open.count > 0 && (
              <ThemedText type="small" themeColor="textSecondary">
                {lively.brighter ? 'Takes a brighter street: ' : 'Passes '}
                {lively.open.count} open {lively.open.count === 1 ? 'place' : 'places'} along the way.
              </ThemedText>
            )}
            {avoiding.length > 0 && (
              <ThemedText type="small" themeColor="warning">
                Routed around {avoiding.join(', ')} reported by other students.
              </ThemedText>
            )}
            {route?.isFallback && (
              <ThemedText type="small" themeColor="warning">
                No Google Maps key set, so this is a straight-line estimate. Add EXPO_PUBLIC_GOOGLE_MAPS_API_KEY for real walking routes.
              </ThemedText>
            )}

            <ThemedText type="smallBold" themeColor="accent" style={styles.eyebrow}>
              ● LEAVING
            </ThemedText>
            <View style={styles.chips}>
              {DEPART_OPTIONS.map((o) => (
                <Chip key={o.minutes} label={o.label} selected={o.minutes === departIn} onPress={() => setDepartIn(o.minutes)} />
              ))}
            </View>

            <ErrorText message={error} />
            <Button
              title={findButtonTitle({ verified, hasActiveGroup: !!activeGroup, hasDestination: !!destination, routeLoading, hasRoute: !!route })}
              icon="people-outline"
              onPress={findBuddies}
              loading={matching}
              disabled={!verified || !route || !!activeGroup}
            />

            <Card>
              <ThemedText type="smallBold">
                {incidents.length ? `${incidents.length} problem${incidents.length === 1 ? '' : 's'} reported nearby right now` : 'No problems reported right now'}
              </ThemedText>
              <ThemedText type="small" themeColor="textSecondary">
                See something broken or unsafe on the way? Report it: it goes to the people who fix it, and walkers nearby
                are rerouted around it.
              </ThemedText>
              <Button compact variant="secondary" icon="add" title="Report an update" onPress={() => setReportOpen(true)} />
            </Card>

            <SafetyBar />
            <ThemedText type="small" themeColor="textSecondary">
              Walking together does not guarantee safety. Stay aware of changing conditions. In an emergency, call 911.
            </ThemedText>
          </View>
        </ScrollView>
      </SafeAreaView>
      <ReportSheet
        visible={reportOpen}
        onClose={() => setReportOpen(false)}
        fallbackLocation={meetup ? { latitude: meetup.lat, longitude: meetup.lng } : null}
      />
    </ThemedView>
  );
}

/** Tells the user what's missing instead of showing a silently disabled button. */
function findButtonTitle(s: {
  verified: boolean;
  hasActiveGroup: boolean;
  hasDestination: boolean;
  routeLoading: boolean;
  hasRoute: boolean;
}) {
  if (!s.verified) return 'Waiting on ID verification';
  if (s.hasActiveGroup) return 'You already have a walk in progress';
  if (!s.hasDestination) return 'Tap the map to set your destination';
  if (s.routeLoading) return 'Finding a walking route…';
  if (!s.hasRoute) return 'No route found — try another spot';
  return 'Find your pack';
}

function minutesFromNow(minutes: number) {
  return new Date(Date.now() + minutes * 60_000);
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 12,
    width: '100%',
    maxWidth: MaxContentWidth,
    alignSelf: 'center',
  },
  h1: {
    fontSize: 26,
    lineHeight: 32,
    fontWeight: '700',
  },
  scroll: {
    paddingBottom: Spacing.five,
  },
  overlay: {
    position: 'absolute',
    left: 16,
    right: 16,
    top: 12,
  },
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderRadius: Radius.md,
    padding: 14,
    shadowOpacity: 0.1,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 3,
  },
  searchLabel: {
    fontSize: 9,
    lineHeight: 12,
    letterSpacing: 0.4,
  },
  searchValue: {
    fontSize: 15,
    fontWeight: '500',
  },
  sheet: {
    paddingHorizontal: 20,
    paddingTop: 14,
    gap: 14,
    width: '100%',
    maxWidth: MaxContentWidth,
    alignSelf: 'center',
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  eyebrow: {
    fontSize: 11,
    letterSpacing: 0.3,
  },
  place: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
  },
  badge: {
    width: 48,
    height: 48,
    borderRadius: Radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: {
    fontSize: 20,
    fontWeight: '700',
  },
  placeName: {
    fontSize: 20,
    lineHeight: 26,
    fontWeight: '700',
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.two,
  },
  chipRow: {
    flexDirection: 'row',
    gap: Spacing.two,
  },
});
