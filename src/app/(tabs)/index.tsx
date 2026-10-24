// Walk planner: choose a meetup point and destination, fetch a walking route, then
// create_walk_request + find_or_create_group (matching happens in Postgres, see AGENTS.md).

import * as Location from 'expo-location';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { Button } from '@/components/button';
import { ReportSheet } from '@/components/report-sheet';
import { Card, ErrorText, Screen } from '@/components/screen';
import { SafetyBar } from '@/components/safety-bar';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { WalkMap, type MapPin, type MapZone } from '@/components/walk-map';
import { useIncidents } from '@/hooks/use-incidents';
import { BottomTabInset, Spacing } from '@/constants/theme';
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
  const meetup = points.find((p) => p.id === meetupId) ?? null;

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
    <Screen bottomInset={BottomTabInset}>
      <ThemedText type="subtitle">Walk home together</ThemedText>

      {!verified && (
        <Card>
          <ThemedText type="smallBold" themeColor="warning">
            ID verification pending
          </ThemedText>
          <ThemedText type="small" themeColor="textSecondary">
            You can plan a route now. Matching with other students unlocks once your ID is approved.
          </ThemedText>
        </Card>
      )}

      {activeGroup && (
        <Card>
          <ThemedText type="smallBold">You have a walk in progress</ThemedText>
          <Button
            title="Return to your group"
            onPress={() => router.push({ pathname: '/group/[id]', params: { id: activeGroup } })}
          />
        </Card>
      )}

<ThemedText type="smallBold">1. Choose where to meet</ThemedText>
<ThemedText type="small" themeColor="textSecondary">
  Select a designated meetup spot, then tap the map to set where you are headed.
  Check your selected meeting point before requesting a walking buddy.
</ThemedText>
      </ScrollView>

     <ThemedText type="smallBold">2. Set your destination</ThemedText>
<ThemedText type="small" themeColor="textSecondary">
  Pack Track will look for students heading in a similar direction.
  Choose a destination and departure time to get started.
</ThemedText>
      <WalkMap pins={pins} route={route?.points} zones={mapZones} onPinPress={(id) => points.some((p) => p.id === id) && selectMeetup(id)} onMapPress={pickDestination} />

      {destination && (
        <Card>
          <ThemedText type="smallBold">{destLabel}</ThemedText>
          <ThemedText type="small" themeColor="textSecondary">
            {routeLoading
              ? 'Finding a walking route…'
              : route
                ? `${formatDistance(route.distanceM)} · about ${formatDuration(route.durationS)} from ${meetup?.name}`
                : 'No route yet'}
          </ThemedText>
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
        </Card>
      )}

      <ThemedText type="smallBold">3. When are you leaving?</ThemedText>
      <View style={styles.chips}>
        {DEPART_OPTIONS.map((o) => (
          <Chip key={o.minutes} label={o.label} selected={o.minutes === departIn} onPress={() => setDepartIn(o.minutes)} />
        ))}
      </View>

      <ErrorText message={error} />
      <Button
        title={findButtonTitle({ verified, hasActiveGroup: !!activeGroup, hasDestination: !!destination, routeLoading, hasRoute: !!route })}
        onPress={findBuddies}
        loading={matching}
        disabled={!verified || !route || !!activeGroup}
      />

      <Card>
        <ThemedText type="smallBold">
          {incidents.length ? `${incidents.length} problem${incidents.length === 1 ? '' : 's'} reported on campus right now` : 'No problems reported right now'}
        </ThemedText>
        <ThemedText type="small" themeColor="textSecondary">
          See something broken or unsafe on the way? Report it: it goes to the people who fix it, and walkers nearby are
          rerouted around it.
        </ThemedText>
        <Button variant="secondary" title="Report a problem" onPress={() => setReportOpen(true)} />
      </Card>

      <SafetyBar />
      <ReportSheet
        visible={reportOpen}
        onClose={() => setReportOpen(false)}
        fallbackLocation={meetup ? { latitude: meetup.lat, longitude: meetup.lng } : null}
      />
    </Screen>
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
  return 'Find walking buddies';
}

function minutesFromNow(minutes: number) {
  return new Date(Date.now() + minutes * 60_000);
}

function Chip({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityState={{ selected }}>
      <ThemedView type={selected ? 'backgroundSelected' : 'backgroundElement'} style={styles.chip}>
        <ThemedText type={selected ? 'smallBold' : 'small'} themeColor={selected ? 'accent' : 'text'}>
          {label}
        </ThemedText>
      </ThemedView>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.two,
  },
  chipRow: {
    flexDirection: 'row',
    gap: Spacing.two,
  },
  chip: {
    paddingVertical: Spacing.two,
    paddingHorizontal: Spacing.three,
    borderRadius: Spacing.four,
  },
});
