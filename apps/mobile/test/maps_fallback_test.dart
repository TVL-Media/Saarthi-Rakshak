import 'dart:convert';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:sarthi_rakshak/api/maps_service.dart';

// With a Google key whose Places / Geocoding API is not enabled (or Google not reachable), place
// search and area names still work through the phone's own geocoder.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(const MethodChannel('sarthi/engine'), (c) async => switch (c.method) {
              'geocodeSearch' => [
                  {'name': 'Sector 18', 'address': 'Sector 18, Noida', 'lat': 28.57, 'lng': 77.32},
                ],
              'geocodeReverse' => {'area': 'Sector 62, Noida'},
              _ => null,
            });
  });

  final refused = MockClient((req) async => req.url.host == 'maps.googleapis.com'
      ? http.Response(jsonEncode({'status': 'REQUEST_DENIED', 'results': []}), 200)
      : http.Response(jsonEncode({'error': {'code': 403, 'status': 'PERMISSION_DENIED'}}), 403));

  test('search falls back to the phone when Google refuses', () async {
    final maps = MapsService(client: refused, apiKey: 'key');
    final found = await maps.search('Sector 18');
    expect(found.single.name, 'Sector 18');
  });

  test('area name falls back to the phone when Google gives none', () async {
    final maps = MapsService(client: refused, apiKey: 'key');
    expect(await maps.areaName(28.62, 77.37), 'Sector 62, Noida');
  });

  test('Google answers are used when they work', () async {
    final ok = MockClient((req) async => http.Response(
        jsonEncode({
          'places': [
            {'displayName': {'text': 'DLF Mall of India'}, 'formattedAddress': 'Sector 18', 'location': {'latitude': 28.56, 'longitude': 77.32}},
          ],
        }),
        200));
    final found = await MapsService(client: ok, apiKey: 'key').search('mall');
    expect(found.single.name, 'DLF Mall of India');
  });
}
