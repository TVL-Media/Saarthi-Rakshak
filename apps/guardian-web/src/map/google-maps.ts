/** Loads the Google Maps JavaScript API once. Rejects without a key or if it fails to load. */
let loading: Promise<void> | null = null;

export function loadGoogleMaps(): Promise<void> {
  const key = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;
  if (!key) return Promise.reject(new Error('No Google Maps key'));
  if (window.google?.maps?.Map) return Promise.resolve();
  loading ??= new Promise<void>((resolve, reject) => {
    const callback = '__sarthiMapsReady';
    (window as unknown as Record<string, () => void>)[callback] = () => resolve();
    const script = document.createElement('script');
    script.src =
      'https://maps.googleapis.com/maps/api/js' +
      `?key=${encodeURIComponent(key)}&libraries=geometry&loading=async&callback=${callback}` +
      '&region=IN&language=en';
    script.async = true;
    script.onerror = () => {
      loading = null;
      reject(new Error('Google Maps did not load'));
    };
    document.head.appendChild(script);
  });
  return loading;
}
