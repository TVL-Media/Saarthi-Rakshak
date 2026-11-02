import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:sarthi_rakshak/api/api_client.dart';
import 'package:sarthi_rakshak/api/models.dart';
import 'package:sarthi_rakshak/config.dart';
import 'package:sarthi_rakshak/screens/auth/login_screen.dart';
import 'package:sarthi_rakshak/screens/journey/checkin_screen.dart';
import 'package:sarthi_rakshak/screens/onboarding/welcome_screen.dart';
import 'package:sarthi_rakshak/screens/sos/sos_active_screen.dart';
import 'package:sarthi_rakshak/screens/sos/sos_countdown_screen.dart';
import 'package:sarthi_rakshak/state/app_state.dart';
import 'package:sarthi_rakshak/theme.dart';

import 'api_client_test.dart' as fixtures;

/// Calls the screens made to the native safety engine.
final engineCalls = <MethodCall>[];

/// Requests the screens made to the server.
final serverCalls = <http.Request>[];

AppState makeState() {
  final api = ApiClient(
    baseUrl: 'http://server',
    client: MockClient((req) async {
      serverCalls.add(req);
      if (req.url.path.startsWith('/v1/sos/') && req.method == 'GET') {
        return http.Response(jsonEncode({'error': 'not_found', 'message': 'SOS not found.'}), 404);
      }
      if (req.url.path.endsWith('/answer')) {
        final answer = (jsonDecode(req.body) as Map)['answer'];
        return http.Response(
          jsonEncode({'id': 'c1', 'reason': 'late', 'source': 'phone', 'status': answer, 'askedAt': '2026-11-02T10:00:00Z'}),
          200,
        );
      }
      return http.Response('', 204);
    }),
  )..token = 't';
  final state = AppState(api: api);
  state.me = Me.fromJson(fixtures.me);
  state.stage = Stage.home;
  return state;
}

Widget host(AppState state, Widget child) =>
    AppScope(state: state, child: MaterialApp(theme: buildTheme(), home: child));

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    engineCalls.clear();
    serverCalls.clear();
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(
      const MethodChannel('sarthi/engine'),
      (call) async {
        engineCalls.add(call);
        return switch (call.method) {
          'getState' => {'mode': 'idle'},
          'deviceInfo' => {'model': 'Pixel 8', 'manufacturer': 'Google', 'androidVersion': '15', 'appVersion': '1.0.0 (1)'},
          'batteryOptimisationOff' => true,
          _ => null,
        };
      },
    );
  });

  testWidgets('Welcome never promises 24/7 monitoring', (tester) async {
    await tester.pumpWidget(host(makeState(), const WelcomeScreen()));
    expect(find.text('Get Started'), findsOneWidget);
    expect(find.text(AppConfig.notMonitoring), findsOneWidget);
    expect(find.textContaining('24/7 Response'), findsNothing);
  });

  testWidgets('Login refuses a number that is not an Indian mobile', (tester) async {
    await tester.pumpWidget(host(makeState(), const LoginScreen()));
    await tester.enterText(find.byKey(const Key('phone')), '12345');
    await tester.tap(find.text('Send OTP'));
    await tester.pump();
    expect(find.text('Enter a 10-digit Indian mobile number.'), findsOneWidget);
    expect(find.text('Emergency? Call 112'), findsOneWidget);
  });

  testWidgets('SOS countdown: at 0 the engine starts the SOS and the SOS screen opens', (tester) async {
    await tester.pumpWidget(host(makeState(), const SosCountdownScreen(trigger: 'button')));
    expect(find.text('5'), findsOneWidget);
    await tester.pump(const Duration(seconds: 1));
    expect(find.text('4'), findsOneWidget);
    await tester.pump(const Duration(seconds: 4));
    await tester.pumpAndSettle(const Duration(milliseconds: 100));

    final start = engineCalls.where((c) => c.method == 'startSos').toList();
    expect(start, hasLength(1));
    final args = start.single.arguments as Map;
    expect(args['trigger'], 'button');
    expect(args['simFallbackSeconds'], 10);
    expect(find.byType(SosActiveScreen), findsOneWidget);
    expect(find.text('Call 112'), findsOneWidget);
    // Nothing is cancelled.
    expect(serverCalls.where((r) => r.url.path == '/v1/sos/cancelled'), isEmpty);
    await tester.pumpWidget(const SizedBox()); // stop the screen's timers
  });

  testWidgets('SOS countdown: cancel sends nothing to guardians and reports a false alarm', (tester) async {
    await tester.pumpWidget(host(
      makeState(),
      Builder(
        builder: (context) => TextButton(
          onPressed: () => Navigator.push(context, MaterialPageRoute(builder: (_) => const SosCountdownScreen(trigger: 'widget'))),
          child: const Text('open'),
        ),
      ),
    ));
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('I’m Safe — cancel'));
    await tester.pumpAndSettle();
    await tester.pump(const Duration(seconds: 6));

    expect(engineCalls.where((c) => c.method == 'startSos'), isEmpty);
    final cancelled = serverCalls.where((r) => r.url.path == '/v1/sos/cancelled').toList();
    expect(cancelled, hasLength(1));
    expect((jsonDecode(cancelled.single.body) as Map)['trigger'], 'widget');
  });

  testWidgets('Check-in preview: answering tells the engine and sends nothing', (tester) async {
    await tester.pumpWidget(host(
      makeState(),
      const CheckinScreen(checkinId: null, reason: 'stopped', journeyId: null, preview: true),
    ));
    expect(find.text('PREVIEW — nothing is sent'), findsOneWidget);
    expect(find.text('2:00'), findsOneWidget);
    await tester.tap(find.text('I’m fine'));
    await tester.pumpAndSettle();
    final answered = engineCalls.where((c) => c.method == 'checkinAnswered').single.arguments as Map;
    expect(answered['answer'], 'fine');
    expect(serverCalls, isEmpty);
  });

  testWidgets('Check-in: "Stuck in traffic" is sent to the server and pauses checks', (tester) async {
    await tester.pumpWidget(host(
      makeState(),
      const CheckinScreen(checkinId: 'c1', reason: 'late', journeyId: 'j1'),
    ));
    await tester.tap(find.text('Stuck in traffic'));
    await tester.pumpAndSettle();
    final req = serverCalls.single;
    expect(req.url.path, '/v1/checkins/c1/answer');
    expect(jsonDecode(req.body), {'answer': 'traffic_pause'});
    final answered = engineCalls.where((c) => c.method == 'checkinAnswered').single.arguments as Map;
    expect(answered['pauseMinutes'], 10);
  });
}
