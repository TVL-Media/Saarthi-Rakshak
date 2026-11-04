import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:sarthi_rakshak/api/api_client.dart';
import 'package:sarthi_rakshak/api/maps_service.dart';
import 'package:sarthi_rakshak/api/models.dart';
import 'package:sarthi_rakshak/engine/engine.dart';
import 'package:sarthi_rakshak/screens/journey/start_journey_screen.dart';
import 'package:sarthi_rakshak/screens/sos/recordings_screen.dart';
import 'package:sarthi_rakshak/screens/sos/sos_active_screen.dart';
import 'package:sarthi_rakshak/state/app_state.dart';
import 'package:sarthi_rakshak/theme.dart';

import 'api_client_test.dart' as fixtures;

final engineCalls = <MethodCall>[];
final settingsOpened = <MethodCall>[];

AppState makeState({List<dynamic> places = const []}) {
  final api = ApiClient(
    baseUrl: 'http://server',
    client: MockClient((req) async {
      final path = req.url.path;
      if (path == '/v1/places') return http.Response(jsonEncode(places), 200);
      if (path.startsWith('/v1/sos/')) {
        return http.Response(
          jsonEncode({
            'id': 's1',
            'trigger': 'button',
            'isTest': false,
            'status': 'active',
            'startedAt': '2026-11-03T10:00:00Z',
            'endedAt': null,
            'guardians': [
              {
                'guardianId': 'g1',
                'name': 'Reena',
                'relation': null,
                'alertedAt': '2026-11-03T10:00:05Z',
                'openedAt': null,
                'respondingAt': null,
              },
            ],
          }),
          200,
        );
      }
      return http.Response('', 204);
    }),
  )..token = 't';
  return AppState(api: api)
    ..me = Me.fromJson(fixtures.me)
    ..stage = Stage.home;
}

Widget host(AppState s, Widget child) => AppScope(
  state: s,
  child: MaterialApp(theme: buildTheme(), home: child),
);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    engineCalls.clear();
    settingsOpened.clear();
    final m = TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    m.setMockMethodCallHandler(const MethodChannel('sarthi/engine'), (call) async {
      engineCalls.add(call);
      return switch (call.method) {
        'geocodeSearch' => [
          {'name': 'Sector 18', 'address': 'Sector 18, Noida, Uttar Pradesh', 'lat': 28.57, 'lng': 77.32},
        ],
        'listClips' => [
          {'id': 'c2', 'sosId': 's1', 'recordedAt': 1793700030000, 'seconds': 30, 'uploaded': false},
          {'id': 'c1', 'sosId': 's1', 'recordedAt': 1793700000000, 'seconds': 30, 'uploaded': true},
        ],
        _ => null,
      };
    });
    // A phone with location turned off.
    for (final name in ['flutter.baseflow.com/geolocator_android', 'flutter.baseflow.com/geolocator']) {
      m.setMockMethodCallHandler(MethodChannel(name), (call) async {
        return switch (call.method) {
          'isLocationServiceEnabled' => false,
          _ => null,
        };
      });
    }
    m.setMockMethodCallHandler(const MethodChannel('flutter.baseflow.com/permissions/methods'), (call) async {
      if (call.method == 'openAppSettings') settingsOpened.add(call);
      return true;
    });
  });

  testWidgets('SOS: guardian shows "Alerted"; audio problem is explained; App permissions opens settings', (
    tester,
  ) async {
    await tester.binding.setSurfaceSize(const Size(400, 1000));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final state = makeState()
      ..engineState = EngineState({
        'mode': 'sos',
        'sosId': 's1',
        'sosSentToServer': true,
        'audioError': 'start failed',
      });
    await tester.pumpWidget(host(state, const SosActiveScreen(sosId: 's1')));
    await tester.pumpAndSettle();

    expect(find.text('Alerted'), findsOneWidget);
    expect(find.text('Audio could not start'), findsOneWidget);
    expect(find.text('start failed. Trying again…'), findsOneWidget);
    await tester.tap(find.byKey(const Key('app-permissions')));
    await tester.pump();
    expect(settingsOpened, hasLength(1));

    // Back from the settings screen: the engine is asked to start what is now allowed.
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    await tester.pump();
    expect(engineCalls.map((c) => c.method), contains('resume'));
    await tester.pumpWidget(const SizedBox()); // stop the screen's timers
  });

  testWidgets('SOS: no microphone permission says where to allow it', (tester) async {
    final state = makeState()..engineState = EngineState({'mode': 'sos', 'sosId': 's1', 'audioOff': true});
    await tester.pumpWidget(host(state, const SosActiveScreen(sosId: 's1')));
    await tester.pumpAndSettle();
    expect(find.text('Audio off'), findsOneWidget);
    expect(find.text('Allow the microphone in App permissions below'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('Journey: no location says what to do; no saved places offers to add one', (tester) async {
    await tester.binding.setSurfaceSize(const Size(400, 1000));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(
      host(makeState(), StartJourneyScreen(maps: MapsService(apiKey: '', deviceGeocoder: false))),
    );
    await tester.pumpAndSettle();
    expect(find.textContaining('Location is turned off'), findsOneWidget); // not stuck on "Finding…"
    expect(find.text('Tap to try again'), findsOneWidget);
    expect(find.text('Finding your location…'), findsNothing);
    expect(find.byKey(const Key('add-place')), findsOneWidget);
  });

  testWidgets('SOS: while recording, a pulsing dot, the time recorded and the saved clips; Listen opens them', (
    tester,
  ) async {
    await tester.binding.setSurfaceSize(const Size(400, 1100));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final since = DateTime.now().millisecondsSinceEpoch - 5000;
    final state = makeState()
      ..engineState = EngineState({
        'mode': 'sos',
        'sosId': 's1',
        'sosSentToServer': true,
        'recording': true,
        'audioClips': 2,
        'audioSavedSeconds': 60,
        'audioClipSince': since,
      });
    await tester.pumpWidget(host(state, const SosActiveScreen(sosId: 's1')));
    await tester.pump(const Duration(milliseconds: 500));

    expect(find.byKey(const Key('recording-dot')), findsOneWidget);
    expect(find.text('Recording audio · 01:05'), findsOneWidget); // 60 s saved + 5 s now
    expect(find.text('2 clips saved on this phone'), findsOneWidget);

    await tester.tap(find.byKey(const Key('listen')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 500));
    expect(find.byType(RecordingsScreen), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('Recordings: lists the clips on this phone and plays one', (tester) async {
    await tester.binding.setSurfaceSize(const Size(400, 1000));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(host(makeState(), const RecordingsScreen(sosId: 's1')));
    await tester.pump();
    await tester.pump();
    expect(find.text('30 s · On this phone only'), findsOneWidget);
    expect(find.text('30 s · Saved to your account'), findsOneWidget);
    final list = engineCalls.firstWhere((c) => c.method == 'listClips');
    expect((list.arguments as Map)['sosId'], 's1');

    await tester.tap(find.byKey(const Key('play-c2')));
    await tester.pump();
    expect((engineCalls.lastWhere((c) => c.method == 'playClip').arguments as Map)['id'], 'c2');
    expect(find.text('Playing'), findsOneWidget);
    await tester.tap(find.byKey(const Key('play-c2')));
    await tester.pump();
    expect(engineCalls.last.method, 'stopPlayback');
    await tester.pumpWidget(const SizedBox());
  });

  test('Server replies that are not ours get a clear message instead of "Something went wrong"', () async {
    Future<ApiException> fail(int status, String body) async {
      final api = ApiClient(baseUrl: 'http://server', client: MockClient((_) async => http.Response(body, status)));
      try {
        await api.me();
      } on ApiException catch (e) {
        return e;
      }
      throw StateError('no error');
    }

    final waking = await fail(503, '<html>Service Unavailable</html>');
    expect(waking.code, 'server_busy');
    expect(waking.message, 'The server is starting or busy. Please try again in a minute.');
    expect((await fail(502, '')).code, 'server_busy');
    final ours = await fail(
      500,
      jsonEncode({'error': 'server_error', 'message': 'Something went wrong. Please try again.'}),
    );
    expect(ours.message, 'Something went wrong. Please try again. (error 500)');
    final storage = await fail(
      503,
      jsonEncode({'error': 'service_unavailable', 'message': 'A service the server needs is not reachable right now.'}),
    );
    expect(storage.code, 'service_unavailable');
    expect(storage.message, contains('(error 503)'));
    final limit = await fail(429, jsonEncode({'error': 'too_many_requests', 'message': 'Too many tries.'}));
    expect(limit.message, 'Too many tries.');
  });

  test('Recorded time = saved clips + the clip being recorded now', () {
    final now = DateTime(2026, 11, 3, 18, 0, 0);
    final since = now.subtract(const Duration(seconds: 12)).millisecondsSinceEpoch;
    final e = EngineState({'recording': true, 'audioSavedSeconds': 90, 'audioClipSince': since});
    expect(e.audioRecorded(now), const Duration(seconds: 102));
    expect(e.audioRecorded(now.add(const Duration(seconds: 1))), const Duration(seconds: 103));
    final stopped = EngineState({'recording': false, 'audioSavedSeconds': 90, 'audioClipSince': 0});
    expect(stopped.audioRecorded(now), const Duration(seconds: 90));
  });

  testWidgets('Journey without a Google key: the phone\'s geocoder finds the destination', (tester) async {
    await tester.binding.setSurfaceSize(const Size(400, 1000));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(host(makeState(), StartJourneyScreen(maps: MapsService(apiKey: ''))));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('add-place')), findsNothing); // search works, no dead end
    await tester.enterText(find.byType(TextField).first, 'sector 18 noida');
    await tester.pump(const Duration(milliseconds: 500));
    await tester.pumpAndSettle();
    final search = engineCalls.lastWhere((c) => c.method == 'geocodeSearch');
    expect((search.arguments as Map)['query'], 'sector 18 noida');
    await tester.tap(find.text('Sector 18'));
    await tester.pumpAndSettle();
    expect(find.text('Reach by'), findsOneWidget); // destination chosen
  });
}
