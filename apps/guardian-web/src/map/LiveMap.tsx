import { useEffect, useRef, useState } from 'react';
import { mapsLink } from '../format';
import { loadGoogleMaps } from './google-maps';

interface Point {
  lat: number;
  lng: number;
  accuracyM: number | null;
}

interface Props {
  /** Newest location, or null if none yet. */
  point: Point | null;
  /** Journey destination and route (Google encoded polyline). */
  destination?: { lat: number; lng: number; label: string } | null;
  route?: string | null;
  tone: 'sos' | 'journey';
}

const COLOURS = { sos: '#b42318', journey: '#1d4ed8' } as const;

/**
 * Live map (Google Maps). Follows the person until the guardian moves the map; "Recentre" follows
 * again. Without a Maps key (or if Maps fails) it shows the place as a link instead.
 */
export function LiveMap({ point, destination, route, tone }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const map = useRef<google.maps.Map | null>(null);
  const person = useRef<google.maps.Marker | null>(null);
  const circle = useRef<google.maps.Circle | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'unavailable'>('loading');
  const [following, setFollowing] = useState(true);
  const followingRef = useRef(true);

  useEffect(() => {
    let cancelled = false;
    loadGoogleMaps()
      .then(() => {
        if (cancelled || !box.current) return;
        const start = point ?? destination ?? { lat: 28.5355, lng: 77.391 }; // Noida
        map.current = new google.maps.Map(box.current, {
          center: { lat: start.lat, lng: start.lng },
          zoom: 16,
          streetViewControl: false,
          mapTypeControl: false,
          fullscreenControl: false,
          clickableIcons: false,
          gestureHandling: 'greedy',
        });
        map.current.addListener('dragstart', () => {
          followingRef.current = false;
          setFollowing(false);
        });
        if (destination) {
          new google.maps.Marker({
            map: map.current,
            position: destination,
            title: destination.label,
            label: { text: '⚑', color: '#ffffff' },
          });
        }
        if (route && google.maps.geometry?.encoding) {
          new google.maps.Polyline({
            map: map.current,
            path: google.maps.geometry.encoding.decodePath(route),
            strokeColor: COLOURS.journey,
            strokeOpacity: 0.6,
            strokeWeight: 5,
          });
        }
        setStatus('ready');
      })
      .catch(() => !cancelled && setStatus('unavailable'));
    return () => {
      cancelled = true;
    };
    // The map is made once; later changes only move the marker (below).
  }, []);

  useEffect(() => {
    if (status !== 'ready' || !map.current || !point) return;
    const position = { lat: point.lat, lng: point.lng };
    if (!person.current) {
      person.current = new google.maps.Marker({
        map: map.current,
        position,
        icon: {
          path: google.maps.SymbolPath.CIRCLE,
          scale: 9,
          fillColor: COLOURS[tone],
          fillOpacity: 1,
          strokeColor: '#ffffff',
          strokeWeight: 3,
        },
        zIndex: 10,
      });
      circle.current = new google.maps.Circle({
        map: map.current,
        center: position,
        radius: point.accuracyM ?? 0,
        fillColor: COLOURS[tone],
        fillOpacity: 0.12,
        strokeOpacity: 0,
        clickable: false,
      });
    } else {
      person.current.setPosition(position);
      circle.current?.setCenter(position);
      circle.current?.setRadius(point.accuracyM ?? 0);
    }
    if (followingRef.current) map.current.panTo(position);
  }, [status, point, tone]);

  const recentre = () => {
    followingRef.current = true;
    setFollowing(true);
    if (map.current && point) map.current.panTo({ lat: point.lat, lng: point.lng });
  };

  if (status === 'unavailable') {
    return (
      <div className="map map-fallback">
        {point ? (
          <>
            <p>The map can’t be shown here.</p>
            <a
              className="btn btn-plain"
              href={mapsLink(point.lat, point.lng)}
              target="_blank"
              rel="noreferrer"
            >
              Open the location in Google Maps
            </a>
            <p className="muted">
              {point.lat.toFixed(5)}, {point.lng.toFixed(5)}
            </p>
          </>
        ) : (
          <p>No location yet. It appears here as soon as the phone sends one.</p>
        )}
      </div>
    );
  }

  return (
    <div className="map-wrap">
      <div ref={box} className="map" aria-label="Live map" role="region" />
      {status === 'ready' && !point && (
        <div className="map-overlay">Waiting for the first location…</div>
      )}
      {status === 'ready' && point && !following && (
        <button className="btn btn-small recentre" onClick={recentre}>
          Recentre
        </button>
      )}
    </div>
  );
}
