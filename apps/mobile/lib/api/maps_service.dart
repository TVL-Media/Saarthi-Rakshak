import 'dart:convert';

import 'package:http/http.dart' as http;

import '../config.dart';
import '../engine/engine.dart';
import 'models.dart';

class PlaceResult {
  PlaceResult(this.name, this.address, this.lat, this.lng);
  final String name;
  final String address;
  final double lat;
  final double lng;
}

class RouteResult {
  RouteResult(this.polyline, this.duration, this.distanceM);
  final String polyline;
  final Duration duration;
  final int distanceM;
}

/// Destination search and the route (Google Places API (New) and Routes API) with MAPS_API_KEY.
/// Without the key, search and place names come from the phone's own geocoder (free, no key) and
/// journeys start without a route (no off-route check).
class MapsService {
  MapsService({http.Client? client, String? apiKey, SafetyEngine? engine, bool deviceGeocoder = true})
      : _http = client ?? http.Client(),
        _key = apiKey ?? AppConfig.mapsApiKey,
        _engine = engine ?? SafetyEngine(),
        _device = deviceGeocoder;

  final http.Client _http;
  final String _key;
  final SafetyEngine _engine;
  final bool _device;

  /// Google services (search, routes, names) are set up.
  bool get available => _key.isNotEmpty;

  /// Places can be searched (Google, or the phone's geocoder).
  bool get canSearch => available || _device;

  Future<List<PlaceResult>> search(String text, {double? nearLat, double? nearLng}) async {
    if (text.trim().length < 2) return const [];
    if (!available) {
      if (!_device) return const [];
      final found = await _engine.geocodeSearch(text.trim());
      return [
        for (final m in found)
          PlaceResult(
            (m['name'] as String?) ?? text.trim(),
            (m['address'] as String?) ?? '',
            (m['lat'] as num).toDouble(),
            (m['lng'] as num).toDouble(),
          ),
      ];
    }
    final res = await _http
        .post(
          Uri.parse('https://places.googleapis.com/v1/places:searchText'),
          headers: {
            'Content-Type': 'application/json',
            'X-Goog-Api-Key': _key,
            'X-Goog-FieldMask': 'places.displayName,places.formattedAddress,places.location',
          },
          body: jsonEncode({
            'textQuery': text.trim(),
            'regionCode': 'IN',
            'languageCode': 'en',
            'maxResultCount': 8,
            if (nearLat != null && nearLng != null)
              'locationBias': {
                'circle': {
                  'center': {'latitude': nearLat, 'longitude': nearLng},
                  'radius': 30000.0,
                },
              },
          }),
        )
        .timeout(const Duration(seconds: 15));
    if (res.statusCode != 200) throw Exception('search ${res.statusCode}');
    final places = (jsonDecode(res.body) as Map<String, dynamic>)['places'] as List? ?? const [];
    return places.map((p) {
      final m = p as Map<String, dynamic>;
      final loc = m['location'] as Map<String, dynamic>;
      return PlaceResult(
        ((m['displayName'] as Map<String, dynamic>?)?['text'] as String?) ?? 'Place',
        (m['formattedAddress'] as String?) ?? '',
        (loc['latitude'] as num).toDouble(),
        (loc['longitude'] as num).toDouble(),
      );
    }).toList();
  }

  /// The address at a position for showing the user where they are (phone's geocoder). Null when
  /// not found.
  Future<String?> addressAt(double lat, double lng) async {
    try {
      final m = await _engine.geocodeReverse(lat, lng);
      final address = (m?['address'] as String?)?.trim();
      return address == null || address.isEmpty ? null : address;
    } catch (_) {
      return null;
    }
  }

  /// Area name for the Home screen, e.g. "Sector 62, Noida" (Geocoding API, or the phone's
  /// geocoder without a key). Null when not available.
  Future<String?> areaName(double lat, double lng) async {
    if (!available) {
      if (!_device) return null;
      try {
        final area = ((await _engine.geocodeReverse(lat, lng))?['area'] as String?)?.trim();
        return area == null || area.isEmpty ? null : area;
      } catch (_) {
        return null;
      }
    }
    final res = await _http
        .get(Uri.https('maps.googleapis.com', '/maps/api/geocode/json', {
          'latlng': '$lat,$lng',
          'result_type': 'sublocality|locality',
          'language': 'en',
          'key': _key,
        }))
        .timeout(const Duration(seconds: 10));
    if (res.statusCode != 200) return null;
    final results = (jsonDecode(res.body) as Map<String, dynamic>)['results'] as List? ?? const [];
    if (results.isEmpty) return null;
    String? part(String type) {
      for (final r in results) {
        for (final c in ((r as Map<String, dynamic>)['address_components'] as List? ?? const [])) {
          final m = c as Map<String, dynamic>;
          if ((m['types'] as List).contains(type)) return m['long_name'] as String?;
        }
      }
      return null;
    }

    final area = part('sublocality_level_1') ?? part('sublocality');
    final city = part('locality');
    final text = [?area, ?city].join(', ');
    return text.isEmpty ? null : text;
  }

  /// Driving route from here to the destination, or null if not available.
  Future<RouteResult?> route(double fromLat, double fromLng, Place to) async {
    if (!available) return null;
    final res = await _http
        .post(
          Uri.parse('https://routes.googleapis.com/directions/v2:computeRoutes'),
          headers: {
            'Content-Type': 'application/json',
            'X-Goog-Api-Key': _key,
            'X-Goog-FieldMask': 'routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline',
          },
          body: jsonEncode({
            'origin': {
              'location': {
                'latLng': {'latitude': fromLat, 'longitude': fromLng},
              },
            },
            'destination': {
              'location': {
                'latLng': {'latitude': to.lat, 'longitude': to.lng},
              },
            },
            'travelMode': 'DRIVE',
          }),
        )
        .timeout(const Duration(seconds: 15));
    if (res.statusCode != 200) return null;
    final routes = (jsonDecode(res.body) as Map<String, dynamic>)['routes'] as List? ?? const [];
    if (routes.isEmpty) return null;
    final r = routes.first as Map<String, dynamic>;
    final seconds = int.tryParse(((r['duration'] as String?) ?? '0s').replaceAll('s', '')) ?? 0;
    return RouteResult(
      ((r['polyline'] as Map<String, dynamic>?)?['encodedPolyline'] as String?) ?? '',
      Duration(seconds: seconds),
      (r['distanceMeters'] as int?) ?? 0,
    );
  }
}

/// Decodes a Google encoded polyline into (lat, lng) pairs.
List<(double, double)> decodePolyline(String encoded) {
  final points = <(double, double)>[];
  var index = 0, lat = 0, lng = 0;
  while (index < encoded.length) {
    for (var i = 0; i < 2; i++) {
      var shift = 0, result = 0, b = 0;
      do {
        b = encoded.codeUnitAt(index++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20 && index < encoded.length);
      final delta = (result & 1) != 0 ? ~(result >> 1) : (result >> 1);
      if (i == 0) {
        lat += delta;
      } else {
        lng += delta;
      }
    }
    points.add((lat / 1e5, lng / 1e5));
  }
  return points;
}
