import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:sarthi_rakshak/api/api_client.dart';
import 'package:sarthi_rakshak/api/models.dart';
import 'package:sarthi_rakshak/screens/fakecall/fake_call_screen.dart';
import 'package:sarthi_rakshak/screens/home/shell.dart';
import 'package:sarthi_rakshak/screens/legal/legal_screen.dart';
import 'package:sarthi_rakshak/screens/settings/settings_screen.dart';
import 'package:sarthi_rakshak/screens/sos/sos_countdown_screen.dart';
import 'package:sarthi_rakshak/state/app_state.dart';
import 'package:sarthi_rakshak/theme.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'api_client_test.dart' as fixtures;

final engineCalls = <MethodCall>[];

http.Client server({bool placesFail = false}) => MockClient((req) async {
  final path = req.url.path;
  if (path == '/v1/places') {
    return placesFail
        ? http.Response(jsonEncode({'error': 'server_error', 'message': 'Something went wrong.'}), 500)
        : http.Response('[]', 200);
  }
  if (path == '/v1/guardians') return http.Response('[]', 200);
  if (path == '/v1/me') return http.Response(jsonEncode(fixtures.me), 200);
  if (path == '/v1/history') return http.Response(jsonEncode({'items': [], 'nextCursor': null}), 200);
  return http.Response('', 204);
});

AppState makeState({bool placesFail = false}) =>
    AppState(
        api: ApiClient(
          baseUrl: 'http://server',
          client: server(placesFail: placesFail),
        )..token = 't',
      )
      ..me = Me.fromJson(fixtures.me)
      ..stage = Stage.home;

Widget host(AppState s, Widget child) => AppScope(
  state: s,
  child: MaterialApp(theme: buildTheme(), home: child),
);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    engineCalls.clear();
    SharedPreferences.setMockInitialValues({});
    FlutterSecureStorage.setMockInitialValues({});
    final m = TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    m.setMockMethodCallHandler(const MethodChannel('sarthi/engine'), (call) async {
      engineCalls.add(call);
      return switch (call.method) {
        'getState' => {'mode': 'idle'},
        'batteryOptimisationOff' => true,
        _ => null,
      };
    });
    m.setMockMethodCallHandler(const MethodChannel('flutter.baseflow.com/permissions/methods'), (c) async => 1);
  });

  Future<void> openCall(WidgetTester tester) async {
    await tester.pumpWidget(
      host(
        makeState(),
        Builder(
          builder: (context) => TextButton(
            onPressed: () =>
                Navigator.push(context, MaterialPageRoute(builder: (_) => const IncomingCallScreen(caller: 'Mom'))),
            child: const Text('open'),
          ),
        ),
      ),
    );
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
    expect(engineCalls.map((c) => c.method), contains('startRingtone'));
  }

  testWidgets('Fake call: Decline stops the ringtone', (tester) async {
    await openCall(tester);
    await tester.tap(find.byIcon(Icons.call_end));
    await tester.pumpAndSettle();
    expect(find.byType(IncomingCallScreen), findsNothing);
    expect(engineCalls.where((c) => c.method == 'stopRingtone'), isNotEmpty);
    expect(engineCalls.last.method, 'stopRingtone'); // nothing starts it again
  });

  testWidgets('Fake call: Back (closing the screen any other way) also stops the ringtone', (tester) async {
    await openCall(tester);
    final nav = tester.state<NavigatorState>(find.byType(Navigator));
    nav.pop();
    await tester.pumpAndSettle();
    expect(engineCalls.where((c) => c.method == 'stopRingtone'), isNotEmpty);
  });

  test(
    'Logging out and in again: a late "not logged in" answer for the old session does not end the new one',
    () async {
      var ended = 0;
      final api = ApiClient(
        baseUrl: 'http://server',
        client: MockClient((req) async {
          if (req.headers['Authorization'] == 'Bearer old') {
            await Future<void>.delayed(const Duration(milliseconds: 20)); // answers after the new login
            return http.Response(jsonEncode({'error': 'not_logged_in', 'message': 'Please log in again.'}), 401);
          }
          return http.Response(jsonEncode(fixtures.me), 200);
        }),
      )..onSessionEnded = () => ended++;

      api.token = 'old';
      final late = api.me().catchError((_) => Me.fromJson(fixtures.me));
      api.token = 'new'; // logged in again before the old answer came
      await late;
      expect(ended, 0);

      // A "not logged in" for the session in use still ends it.
      api.token = 'old';
      await api.me().catchError((_) => Me.fromJson(fixtures.me));
      expect(ended, 1);
    },
  );

  testWidgets('Back on another tab goes to Home instead of closing the app', (tester) async {
    await tester.binding.setSurfaceSize(const Size(400, 860));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(host(makeState(), const Shell()));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Settings'));
    await tester.pumpAndSettle();
    expect(find.text('Log Out'), findsOneWidget);

    final handled = await tester.binding.handlePopRoute();
    await tester.pumpAndSettle();
    expect(handled, isTrue); // the app stays open
    expect(find.text('Where are you going?'), findsOneWidget); // on Home
  });

  testWidgets('SOS countdown vibrates when it starts and every second', (tester) async {
    await tester.pumpWidget(host(makeState(), const SosCountdownScreen(trigger: 'button')));
    expect(engineCalls.where((c) => c.method == 'vibrate'), hasLength(1));
    await tester.pump(const Duration(seconds: 1));
    await tester.pump(const Duration(seconds: 1));
    expect(engineCalls.where((c) => c.method == 'vibrate'), hasLength(3));
    await tester.tap(find.text('I’m Safe — cancel'));
    await tester.pump(const Duration(seconds: 2));
    expect(engineCalls.where((c) => c.method == 'vibrate'), hasLength(3)); // stops when cancelled
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('Privacy Policy and Terms open inside the app', (tester) async {
    await tester.binding.setSurfaceSize(const Size(400, 860));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(host(makeState(), const SettingsScreen()));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Privacy Policy'));
    await tester.pumpAndSettle();
    expect(find.byType(LegalScreen), findsOneWidget);
    expect(find.text('Who we are'), findsOneWidget);
    Navigator.of(tester.element(find.byType(LegalScreen))).pop();
    await tester.pumpAndSettle();
    await tester.tap(find.text('Terms & Conditions'));
    await tester.pumpAndSettle();
    expect(find.text('About these terms'), findsOneWidget);
  });

  testWidgets('Saved places: a server error shows Try again instead of spinning forever', (tester) async {
    await tester.pumpWidget(host(makeState(placesFail: true), const SavedPlacesScreen()));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('places-retry')), findsOneWidget);
    expect(find.byType(CircularProgressIndicator), findsNothing);
  });

  group('Short server blips', () {
    setUp(() => ApiClient.retryDelay = Duration.zero);
    tearDown(() => ApiClient.retryDelay = const Duration(seconds: 2));

    test('a read is tried once more and then works (no error on screen)', () async {
      var calls = 0;
      final api = ApiClient(
        baseUrl: 'http://server',
        client: MockClient((req) async {
          calls++;
          return calls == 1 ? http.Response('<html>Bad Gateway</html>', 502) : http.Response('[]', 200);
        }),
      )..token = 't';
      expect(await api.places(), isEmpty);
      expect(calls, 2);
    });

    test('a save is never repeated (nothing done twice)', () async {
      var calls = 0;
      final api = ApiClient(
        baseUrl: 'http://server',
        client: MockClient((req) async {
          calls++;
          return http.Response('', 503);
        }),
      )..token = 't';
      await expectLater(api.savePlace('home', 'Home', 28.6, 77.3), throwsA(isA<ApiException>()));
      expect(calls, 1);
    });

    test('still failing after the second try: a clear message', () async {
      var calls = 0;
      final api = ApiClient(
        baseUrl: 'http://server',
        client: MockClient((req) async {
          calls++;
          return http.Response('', 503);
        }),
      )..token = 't';
      try {
        await api.places();
        fail('no error');
      } on ApiException catch (e) {
        expect(e.message, 'The server is starting or busy. Please try again in a minute.');
      }
      expect(calls, 2);
    });
  });
}
