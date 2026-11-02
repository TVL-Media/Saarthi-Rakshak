import 'dart:convert';

import 'package:http/http.dart' as http;

import '../config.dart';
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

/// Destination search and the route (Google Places API (New) and Routes API). Needs MAPS_API_KEY;
/// without it, search returns nothing and journeys start without a route (no off-route check).
class MapsService {
  MapsService({http.Client? client, String? apiKey})
      : _http = client ?? http.Client(),
        _key = apiKey ?? AppConfig.mapsApiKey;

  final http.Client _http;
  final String _key;

  bool get available => _key.isNotEmpty;

  Future<List<PlaceResult>> search(String text, {double? nearLat, double? nearLng}) async {
    if (!available || text.trim().length < 2) return const [];
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
