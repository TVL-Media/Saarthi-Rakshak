import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:sarthi_rakshak/api/api_client.dart';
import 'package:sarthi_rakshak/api/models.dart';
import 'package:sarthi_rakshak/screens/auth/profile_screen.dart';
import 'package:sarthi_rakshak/screens/setup/safety_setup_screen.dart';
import 'package:sarthi_rakshak/state/app_state.dart';
import 'package:sarthi_rakshak/theme.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'api_client_test.dart' as fixtures;

final patches = <Map<String, dynamic>>[];
final engineCalls = <String>[];
final permissionRequests = <int>[];

http.Client server() => MockClient((req) async {
      if (req.url.path == '/v1/me' && req.method == 'PATCH') {
        final body = jsonDecode(req.body) as Map<String, dynamic>;
        patches.add(body);
        return http.Response(jsonEncode({...fixtures.me, ...body}), 200);
      }
      if (req.url.path == '/v1/guardians') return http.Response('[]', 200);
      return http.Response('', 204);
    });

AppState makeState() => AppState(api: ApiClient(baseUrl: 'http://server', client: server())..token = 't')
  ..me = Me.fromJson(fixtures.me)
  ..stage = Stage.home;

Widget host(AppState s, Widget child) => AppScope(state: s, child: MaterialApp(theme: buildTheme(), home: child));

void main() {
  setUp(() {
    patches.clear();
    engineCalls.clear();
    permissionRequests.clear();
    SharedPreferences.setMockInitialValues({});
    FlutterSecureStorage.setMockInitialValues({});
    final m = TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    m.setMockMethodCallHandler(const MethodChannel('sarthi/engine'), (c) async {
      engineCalls.add(c.method);
      return switch (c.method) {
        'deviceInfo' => {'manufacturer': 'Xiaomi', 'model': 'Redmi'},
        'batteryOptimisationOff' => false,
        _ => null,
      };
    });
    // Every permission starts "denied"; asking grants it.
    final granted = <int>{};
    m.setMockMethodCallHandler(const MethodChannel('flutter.baseflow.com/permissions/methods'), (c) async {
      switch (c.method) {
        case 'checkPermissionStatus':
          return granted.contains(c.arguments) ? 1 : 0;
        case 'requestPermissions':
          final asked = (c.arguments as List).cast<int>();
          permissionRequests.addAll(asked);
          granted.addAll(asked);
          return {for (final p in asked) p: 1};
        default:
          return true;
      }
    });
  });

  testWidgets('Safety setup: "Allow all" asks for every missing permission and the battery setting', (tester) async {
    await tester.binding.setSurfaceSize(const Size(412, 1400));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(host(makeState(), const SafetySetupScreen()));
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const Key('allow-all')));
    await tester.pumpAndSettle();
    // permission_handler numbers: location 3, locationAlways 4, notification 17, microphone 7, sms 13.
    expect(permissionRequests, containsAllInOrder([3, 4, 17, 7, 13]));
    expect(engineCalls, contains('askBatteryOptimisationOff'));
  });

  testWidgets('My Profile saves the extra details; empty ones are cleared', (tester) async {
    await tester.binding.setSurfaceSize(const Size(412, 1800));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(host(makeState(), const ProfileScreen(fromSettings: true)));
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const Key('gender-female')));
    await tester.enterText(find.byKey(const Key('email')), ' priya@example.com ');
    await tester.enterText(find.byKey(const Key('medical')), 'Asthma');
    await tester.tap(find.text('Save'));
    await tester.pumpAndSettle();

    expect(patches.single, {
      'name': 'Priya Sharma',
      'bloodGroup': 'B+',
      'gender': 'female',
      'dateOfBirth': null,
      'email': 'priya@example.com',
      'homeAddress': null,
      'medicalNotes': 'Asthma',
    });
  });

  testWidgets('My Profile refuses a wrong email before sending', (tester) async {
    await tester.binding.setSurfaceSize(const Size(412, 1800));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(host(makeState(), const ProfileScreen(fromSettings: true)));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const Key('email')), 'priya@');
    await tester.tap(find.text('Save'));
    await tester.pumpAndSettle();
    expect(find.text('Enter a valid email address.'), findsOneWidget);
    expect(patches, isEmpty);
  });
}
