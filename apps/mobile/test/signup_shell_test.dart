import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:sarthi_rakshak/api/api_client.dart';
import 'package:sarthi_rakshak/api/models.dart';
import 'package:sarthi_rakshak/screens/auth/login_screen.dart';
import 'package:sarthi_rakshak/screens/guardians/guardians_screen.dart';
import 'package:sarthi_rakshak/screens/home/shell.dart';
import 'package:sarthi_rakshak/state/app_state.dart';
import 'package:sarthi_rakshak/theme.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'api_client_test.dart' as fixtures;

final serverCalls = <http.Request>[];

/// A server with no places, guardians or history, and a new user who has not accepted the terms.
http.Client fakeServer() => MockClient((req) async {
      serverCalls.add(req);
      final path = req.url.path;
      final newUser = {...fixtures.me, 'name': null, 'consentGiven': false, 'guardiansCount': 0};
      return switch (path) {
        '/v1/places' || '/v1/guardians' => http.Response('[]', 200),
        '/v1/history' => http.Response(jsonEncode({'items': [], 'nextCursor': null}), 200),
        '/v1/auth/dev-login' => http.Response(jsonEncode({'token': 'tok', 'user': newUser, 'isNewUser': true}), 200),
        '/v1/me/consent' => http.Response(jsonEncode({...newUser, 'consentGiven': true}), 200),
        '/v1/me' when req.method == 'PATCH' =>
          http.Response(jsonEncode({...newUser, 'consentGiven': true, 'name': (jsonDecode(req.body) as Map)['name']}), 200),
        '/v1/me' => http.Response(jsonEncode(fixtures.me), 200),
        _ => http.Response('', 204),
      };
    });

Widget host(AppState state, Widget child) =>
    AppScope(state: state, child: MaterialApp(theme: buildTheme(), home: child));

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    serverCalls.clear();
    SharedPreferences.setMockInitialValues({});
    FlutterSecureStorage.setMockInitialValues({});
    final messenger = TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    messenger.setMockMethodCallHandler(const MethodChannel('sarthi/engine'), (call) async {
      return switch (call.method) {
        'getState' => {'mode': 'idle'},
        'deviceInfo' => {'model': 'Pixel 8', 'androidVersion': '15', 'appVersion': '1.0.0 (1)'},
        'batteryOptimisationOff' => true,
        'pickContact' => {'name': 'Ravi Kumar', 'phone': '+91 98765-43210'},
        _ => null,
      };
    });
    // permission_handler: every permission "granted".
    messenger.setMockMethodCallHandler(const MethodChannel('flutter.baseflow.com/permissions/methods'), (call) async => 1);
  });

  testWidgets('Bottom bar: SOS button in the middle and each tab shows its own page', (tester) async {
    await tester.binding.setSurfaceSize(const Size(400, 860));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final state = AppState(api: ApiClient(baseUrl: 'http://server', client: fakeServer())..token = 't');
    state.me = Me.fromJson(fixtures.me);
    state.stage = Stage.home;
    await tester.pumpWidget(host(state, const Shell()));
    await tester.pumpAndSettle();

    expect(find.byType(SosHoldButton), findsOneWidget);
    expect(find.text('SOS'), findsOneWidget);
    expect(find.text('Where are you going?'), findsOneWidget);

    // The bar stays small: the page above it is visible.
    final bar = tester.getRect(find.byType(SosHoldButton));
    expect(bar.top, greaterThan(700));
    expect(tester.getRect(find.text('Where are you going?')).bottom, lessThan(bar.top));

    await tester.tap(find.text('Settings'));
    await tester.pumpAndSettle();
    expect(find.text('Log Out'), findsOneWidget);

    await tester.tap(find.text('Guardians').last);
    await tester.pumpAndSettle();
    expect(find.text('Trusted Guardians'), findsOneWidget);
    expect(find.text('Add Guardian'), findsOneWidget);

    await tester.tap(find.text('History').last);
    await tester.pumpAndSettle();
    expect(find.text('No SOS or journeys yet'), findsOneWidget);

    await tester.tap(find.text('Home'));
    await tester.pumpAndSettle();
    await tester.tap(find.byTooltip('Menu'));
    await tester.pumpAndSettle();
    expect(find.text('My Journeys'), findsOneWidget);
    expect(find.text('Logout'), findsOneWidget);
  });

  testWidgets('Sign up asks for the name, the number and the terms; Login is one tap away', (tester) async {
    final state = AppState(api: ApiClient(baseUrl: 'http://server', client: fakeServer()));
    await tester.pumpWidget(host(state, const LoginScreen(signUp: true)));
    expect(find.text('Create Account'), findsOneWidget);

    await tester.tap(find.text('Sign Up'));
    await tester.pump();
    expect(find.text('Enter your name (at least 2 characters)'), findsOneWidget);

    await tester.enterText(find.byKey(const Key('name')), 'Priya Sharma');
    await tester.enterText(find.byKey(const Key('phone')), '9876543210');
    await tester.tap(find.text('Sign Up'));
    await tester.pump();
    expect(find.text('Please agree to the Terms & Conditions.'), findsOneWidget);

    await tester.tap(find.byKey(const Key('switch-mode')));
    await tester.pump();
    expect(find.text('Welcome Back'), findsOneWidget);
    expect(find.byKey(const Key('name')), findsNothing);
    expect(find.text('Send OTP'), findsOneWidget);

    await tester.tap(find.byKey(const Key('switch-mode')));
    await tester.pump();
    expect(find.text('Create Account'), findsOneWidget);
  });

  test('Sign up name is saved after the terms are accepted', () async {
    final state = AppState(api: ApiClient(baseUrl: 'http://server', client: fakeServer()));
    await state.loginWithDevCode('+919876543210', '159344', signUpName: 'Priya Sharma');
    expect(state.stage, Stage.consent);
    // Nothing is saved before the terms are accepted (the server would refuse it).
    expect(serverCalls.where((r) => r.method == 'PATCH'), isEmpty);

    await state.giveConsent();
    final patch = serverCalls.singleWhere((r) => r.method == 'PATCH' && r.url.path == '/v1/me');
    expect(jsonDecode(patch.body), {'name': 'Priya Sharma'});
    expect(state.me!.name, 'Priya Sharma');
    expect(state.stage, Stage.guardians); // the profile step is skipped: the name is set
  });

  testWidgets('Add guardian: "Choose from contacts" fills the name and the number', (tester) async {
    await tester.binding.setSurfaceSize(const Size(400, 860));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final state = AppState(api: ApiClient(baseUrl: 'http://server', client: fakeServer())..token = 't');
    state.me = Me.fromJson(fixtures.me);
    await tester.pumpWidget(host(state, const GuardiansScreen()));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Add Guardian'));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('pick-contact')));
    await tester.pumpAndSettle();
    expect(find.text('Ravi Kumar'), findsOneWidget);
    expect(find.text('9876543210'), findsOneWidget);
  });
}
