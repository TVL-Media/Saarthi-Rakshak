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
      return null;
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
    expect(find.text('Audio could not start (start failed). Trying again…'), findsOneWidget);
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
    expect(find.text('Audio off — allow the microphone in App permissions'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('Journey: no location says what to do; no saved places offers to add one', (tester) async {
    await tester.binding.setSurfaceSize(const Size(400, 1000));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(host(makeState(), StartJourneyScreen(maps: MapsService(apiKey: ''))));
    await tester.pumpAndSettle();
    expect(find.textContaining('Location is turned off'), findsOneWidget); // not stuck on "Finding…"
    expect(find.text('Tap to try again'), findsOneWidget);
    expect(find.text('Finding your location…'), findsNothing);
    expect(find.byKey(const Key('add-place')), findsOneWidget);
  });
}
