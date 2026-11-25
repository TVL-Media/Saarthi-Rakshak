import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:sarthi_rakshak/api/api_client.dart';
import 'package:sarthi_rakshak/api/models.dart';
import 'package:sarthi_rakshak/screens/community/community_screen.dart';
import 'package:sarthi_rakshak/screens/daily/daily_location_screen.dart';
import 'package:sarthi_rakshak/screens/settings/plans_screen.dart';
import 'package:sarthi_rakshak/screens/settings/sos_triggers_screen.dart';
import 'package:sarthi_rakshak/screens/sos/sos_countdown_screen.dart';
import 'package:sarthi_rakshak/screens/vault/share_import_screen.dart';
import 'package:sarthi_rakshak/screens/vault/vault_screen.dart';
import 'package:sarthi_rakshak/screens/vault/vault_setup_screen.dart';
import 'package:sarthi_rakshak/state/app_state.dart';
import 'package:sarthi_rakshak/state/vault_session.dart';
import 'package:sarthi_rakshak/theme.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'api_client_test.dart' as fixtures;

final engineCalls = <MethodCall>[];
final serverCalls = <http.Request>[];

/// Server answers for the Phase 2 screens (only what the tests need).
http.Response answer(http.Request req) {
  final p = req.url.path;
  Map<String, Object?> triggers(Map<String, Object?> change) => {
        'shakeMode': 'off',
        'voiceOn': false,
        'driveMode': false,
        'fallOn': false,
        'quietCountdown': false,
        'journeySosButton': true,
        ...change,
      };
  if (p == '/v1/me/sos-triggers') {
    return http.Response(jsonEncode(triggers(req.method == 'PUT' ? jsonDecode(req.body) as Map<String, Object?> : {})), 200);
  }
  if (p == '/v1/me/daily-tracking') {
    final body = req.method == 'PUT' ? jsonDecode(req.body) as Map<String, Object?> : <String, Object?>{};
    return http.Response(
      jsonEncode({
        'enabled': body['enabled'] ?? false,
        'pausedUntil': null,
        'retentionDays': body['retentionDays'] ?? 30,
        'consentVersion': body['consentVersion'],
      }),
      200,
    );
  }
  if (p == '/v1/vault/recovery') return http.Response(jsonEncode({'error': 'not_found', 'message': 'No vault.'}), 404);
  if (p == '/v1/vault/items' || p == '/v1/vault/incidents') return http.Response('[]', 200);
  if (p == '/v1/vault/usage') return http.Response(jsonEncode({'usedBytes': 0, 'limitBytes': 50 * 1024 * 1024 * 1024, 'items': 0}), 200);
  if (p == '/v1/community/areas') return http.Response(jsonEncode({'areas': ['Sector 18', 'Sector 62']}), 200);
  if (p == '/v1/community/my-reports') {
    return http.Response(
      jsonEncode([
        {
          'id': '22222222-2222-4222-8222-222222222222',
          'category': 'road',
          'area': 'Sector 3',
          'body': 'Big pothole at the crossing',
          'photoUrl': null,
          'official': false,
          'createdAt': '2026-11-24T11:42:07Z',
          'status': 'pending',
          'reason': null,
        },
      ]),
      200,
    );
  }
  if (p == '/v1/community/posts') {
    return http.Response(
      jsonEncode([
        {
          'id': '11111111-1111-4111-8111-111111111111',
          'category': 'lighting',
          'area': 'Sector 18',
          'body': 'The street light near the park gate is broken.',
          'photoUrl': null,
          'official': false,
          'createdAt': '2026-11-10T10:00:00Z',
        },
      ]),
      200,
    );
  }
  if (p == '/v1/plans') {
    return http.Response(
      jsonEncode({
        'plans': [
          for (final (id, name, mb) in [('basic', 'Basic', 2048), ('silver', 'Silver', 10240), ('gold', 'Gold', 51200)])
            {
              'id': id,
              'name': name,
              'monthlyPriceInr': null,
              'yearlyPriceInr': null,
              'monthlyProductId': null,
              'yearlyProductId': null,
              'features': ['Evidence vault'],
              'evidenceStorageMb': mb,
              'onSale': false,
            },
        ],
        'current': 'basic',
        'everythingFree': true,
        'renewsAt': null,
      }),
      200,
    );
  }
  return http.Response('', 204);
}

AppState makeState() {
  final api = ApiClient(
    baseUrl: 'http://server',
    client: MockClient((req) async {
      serverCalls.add(req);
      return answer(req);
    }),
  )..token = 't';
  final state = AppState(api: api);
  state.me = Me.fromJson(fixtures.me);
  state.stage = Stage.home;
  return state;
}

Widget host(AppState state, Widget child) => AppScope(state: state, child: MaterialApp(theme: buildTheme(), home: child));

Map<String, Object?> lastBody(String method, String path) =>
    jsonDecode(serverCalls.lastWhere((r) => r.method == method && r.url.path == path).body) as Map<String, Object?>;

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    engineCalls.clear();
    serverCalls.clear();
    VaultSession.testAuth = (_) async => true;
    SharedPreferences.setMockInitialValues({});
    final messenger = TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    messenger.setMockMethodCallHandler(const MethodChannel('sarthi/engine'), (call) async {
      engineCalls.add(call);
      final args = (call.arguments as Map?) ?? const {};
      return switch (call.method) {
        'getState' => {'mode': 'idle'},
        'deviceInfo' => {'model': 'Pixel 8', 'manufacturer': 'Google'},
        'vaultExists' => false,
        'vaultNewKey' => base64Encode(List.filled(32, 7)),
        // A fake "encryption" that can be undone, so locked details read back in the test.
        'vaultEncrypt' => 'L${args['plain']}',
        'vaultDecrypt' => (args['locked'] as String).substring(1),
        'sha256Bytes' => 'a' * 64,
        'vaultUnlock' => base64Encode(List.filled(32, 7)),
        'practiceShake' => true,
        'voiceHasModel' => false,
        _ => null,
      };
    });
    // permission_handler: everything allowed.
    messenger.setMockMethodCallHandler(const MethodChannel('flutter.baseflow.com/permissions/methods'), (call) async {
      return switch (call.method) {
        'checkPermissionStatus' => 1,
        'requestPermissions' => {for (final p in (call.arguments as List)) p: 1},
        _ => null,
      };
    });
  });

  tearDown(() => VaultSession.testAuth = null);

  testWidgets('SOS triggers: shake "Always" is saved and handed to the engine; practice shake never starts an SOS',
      (tester) async {
    final state = makeState();
    await tester.pumpWidget(host(state, const SosTriggersScreen()));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Always'));
    await tester.pumpAndSettle();
    expect(lastBody('PUT', '/v1/me/sos-triggers'), {'shakeMode': 'always'});
    expect(state.triggers.shakeMode, 'always');
    final config = engineCalls.lastWhere((c) => c.method == 'engineConfig');
    expect(jsonDecode((config.arguments as Map)['triggers'] as String)['shakeMode'], 'always');
    expect(find.textContaining('notification stays on'), findsOneWidget);

    await tester.tap(find.text('Try a practice shake'));
    await tester.pumpAndSettle();
    expect(find.textContaining('Shake felt'), findsOneWidget);
    expect(engineCalls.where((c) => c.method == 'startSos'), isEmpty);
  });

  testWidgets('SOS triggers: drive mode asks first (beta) and is not turned on if cancelled', (tester) async {
    await tester.binding.setSurfaceSize(const Size(400, 1400));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(host(makeState(), const SosTriggersScreen()));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Drive mode'));
    await tester.pumpAndSettle();
    expect(find.text('Drive mode (beta)'), findsOneWidget);
    await tester.tap(find.text('Cancel'));
    await tester.pumpAndSettle();
    expect(serverCalls.where((r) => r.method == 'PUT'), isEmpty);
    await tester.tap(find.text('Drive mode'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Turn on'));
    await tester.pumpAndSettle();
    expect(lastBody('PUT', '/v1/me/sos-triggers'), {'driveMode': true});
  });

  testWidgets('Full-day location: the consent comes first and its version is sent', (tester) async {
    final state = makeState();
    await tester.pumpWidget(host(state, const DailyLocationScreen()));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('daily-switch')));
    await tester.pumpAndSettle();
    expect(find.byType(DailyConsentScreen), findsOneWidget);
    await tester.tap(find.byKey(const Key('daily-agree')));
    await tester.pumpAndSettle();
    expect(lastBody('PUT', '/v1/me/daily-tracking'), {'enabled': true, 'consentVersion': dailyConsentVersion});
    expect(state.daily.enabled, isTrue);
    expect(dailyConsentVersion, '2026-11'); // must match DAILY_CONSENT_VERSION on the server
  });
  testWidgets('Mere Saboot: set a password (typed twice); the key is sent locked with it, fingerprint kept', (tester) async {
    await tester.binding.setSurfaceSize(const Size(400, 1800));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(host(makeState(), const VaultScreen()));
    await tester.pumpAndSettle();
    expect(find.text(vaultTagline), findsOneWidget);
    expect(find.text('Set a password'), findsOneWidget);
    expect(find.textContaining('12 words'), findsNothing); // no recovery phrase any more

    final fields = find.byType(TextField);
    await tester.enterText(fields.at(0), 'abc');
    await tester.enterText(fields.at(1), 'abd');
    await tester.tap(find.text('Set password'));
    await tester.pumpAndSettle();
    expect(find.text('The two passwords are not the same.'), findsOneWidget);
    expect(serverCalls.where((r) => r.url.path == '/v1/vault/setup'), isEmpty);

    // Any password is accepted, even a short one (owner's decision).
    await tester.enterText(fields.at(1), 'abc');
    // Argon2id runs for real (a few seconds), outside the test's fake clock.
    await tester.runAsync(() async {
      await tester.tap(find.text('Set password'));
      for (var i = 0; i < 60 && !serverCalls.any((r) => r.url.path == '/v1/vault/usage'); i++) {
        await Future<void>.delayed(const Duration(milliseconds: 500));
      }
    });
    await tester.pumpAndSettle();
    final setup = lastBody('POST', '/v1/vault/setup');
    expect((setup['kdf'] as Map)['name'], 'argon2id');
    expect((setup['kdf'] as Map)['secret'], 'password');
    // The vault key is locked with a key made from the password (Argon2id), not sent as it is.
    final vaultKey = base64Encode(List.filled(32, 7));
    final lock = engineCalls.firstWhere((c) => c.method == 'vaultEncrypt');
    expect((lock.arguments as Map)['plain'], vaultKey);
    expect((lock.arguments as Map)['key'], isNot(vaultKey));
    expect(setup['lockedKey'], 'L$vaultKey'); // what the fake engine returned for that lock
    expect(setup.containsKey('key'), isFalse);
    expect(engineCalls.any((c) => c.method == 'vaultStore'), isTrue); // "Also open with fingerprint"
    expect(find.text('Add evidence'.toUpperCase()), findsOneWidget);

    // Lock: the page stays and changes to the password screen (it used to close at once).
    await tester.tap(find.byTooltip('Lock'));
    await tester.pumpAndSettle();
    expect(find.byType(VaultScreen), findsOneWidget);
    expect(find.text('Enter your password'), findsOneWidget);
    expect(find.text('Mere Saboot is locked.'), findsOneWidget);
  }, timeout: const Timeout(Duration(minutes: 2)));

  testWidgets('Community: reports you sent are listed under the button with their status', (tester) async {
    await tester.binding.setSurfaceSize(const Size(400, 1400));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(host(makeState(), const CommunityScreen()));
    await tester.pumpAndSettle();
    expect(find.text('Reports you sent'.toUpperCase()), findsOneWidget);
    expect(find.text('Big pothole at the crossing'), findsOneWidget);
    expect(find.text('Sent · being checked'), findsOneWidget);
  });

  testWidgets('Community: posts load and a post can be reported', (tester) async {
    await tester.pumpWidget(host(makeState(), const CommunityScreen()));
    await tester.pumpAndSettle();
    expect(find.text('Poor lighting'), findsOneWidget);
    await tester.tap(find.byTooltip('Report this post'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField), 'Not true');
    await tester.tap(find.descendant(of: find.byType(AlertDialog), matching: find.text('Report')));
    await tester.pumpAndSettle();
    expect(lastBody('POST', '/v1/community/posts/11111111-1111-4111-8111-111111111111/flag'), {'reason': 'Not true'});
  });

  testWidgets('Plans: while everything is free there is nothing to buy', (tester) async {
    await tester.pumpWidget(host(makeState(), const PlansScreen()));
    await tester.pumpAndSettle();
    expect(find.textContaining('Everything is free for now'), findsOneWidget);
    expect(find.text('Coming soon'), findsNWidgets(3));
    expect(find.byType(FilledButton), findsNothing);
  });

  testWidgets('A shake countdown cancelled with "I\'m OK" is counted as a false alarm', (tester) async {
    await tester.pumpWidget(host(makeState(), const SosCountdownScreen(trigger: 'shake')));
    await tester.pump();
    await tester.tap(find.byKey(const Key('cancel-sos')));
    await tester.pumpAndSettle();
    expect(lastBody('POST', '/v1/sos/false-alarms')['trigger'], 'shake');
    expect(engineCalls.where((c) => c.method == 'startSos'), isEmpty);
  });

  test('Shared files get the right evidence kind', () {
    expect(SharedFile.fromMap({'path': '/x/a.jpg', 'name': 'a.jpg', 'mime': 'image/jpeg'}).kind, 'photo');
    expect(SharedFile.fromMap({'path': '/x/b', 'name': 'chat.mp4', 'mime': 'video/mp4'}).kind, 'video');
    expect(SharedFile.fromMap({'path': '/x/c', 'name': 'note.opus', 'mime': 'application/octet-stream'}).kind, 'audio');
    expect(SharedFile.fromMap({'path': '/x/d', 'name': 'bill.pdf', 'mime': 'application/pdf'}).kind, 'file');
  });

  test('Journey travel mode is sent to the server', () async {
    final state = makeState();
    await state.api
        .startJourney('j1', Place(lat: 28.5, lng: 77.3, label: 'Office'), DateTime.utc(2026, 11, 11, 10), null, mode: 'cab')
        .catchError((_) => throw StateError('ignored'))
        .then((_) {}, onError: (_) {});
    expect(lastBody('POST', '/v1/journeys')['mode'], 'cab');
  });

  test('Mere Saboot saves at once; the upload runs in the background (no waiting for the internet)', () async {
    final tmp = Directory.systemTemp.createTempSync('vault');
    final messenger = TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    messenger.setMockMethodCallHandler(const MethodChannel('plugins.flutter.io/path_provider'), (c) async => tmp.path);
    messenger.setMockMethodCallHandler(const MethodChannel('sarthi/engine'), (call) async {
      final args = (call.arguments as Map?) ?? const {};
      switch (call.method) {
        case 'vaultUnlock':
          return base64Encode(List.filled(32, 7));
        case 'vaultNewKey':
          return base64Encode(List.filled(32, 9));
        case 'vaultEncrypt':
          return 'L${args['plain']}';
        case 'vaultEncryptFile':
          File(args['output'] as String).writeAsBytesSync(List.filled(64, 1));
          return {'sha256': 'a' * 64, 'size': 64};
      }
      return null;
    });
    // The server never answers (a very slow network).
    final never = Completer<http.Response>();
    final api = ApiClient(baseUrl: 'http://server', client: MockClient((req) => never.future))..token = 't';
    final state = AppState(api: api)..me = Me.fromJson(fixtures.me);
    expect(await state.vault.unlock(), isTrue);
    final source = File('${tmp.path}/rec.m4a')..writeAsBytesSync(List.filled(100, 2));

    final id = await state.vault
        .addFile(path: source.path, kind: 'audio', details: ItemDetails(note: 'x'), deleteSource: true)
        .timeout(const Duration(seconds: 5));

    expect(source.existsSync(), isFalse); // only the encrypted copy is kept
    expect((await state.vault.pending()).single.id, id);
    expect(state.vault.isUploading(id), isTrue);
  });

  /// A fake engine whose "hash" depends on its input, so a wrong password gives a different check.
  void passwordEngine() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(const MethodChannel('sarthi/engine'), (call) async {
      engineCalls.add(call);
      final args = (call.arguments as Map?) ?? const {};
      return switch (call.method) {
        'vaultNewKey' => base64Encode(List.filled(32, 7)),
        'vaultEncrypt' => 'L${args['plain']}',
        'vaultDecrypt' => (args['locked'] as String).substring(1),
        'sha256Bytes' => args['data'],
        'vaultExists' => false,
        _ => null,
      };
    });
  }

  test('Mere Saboot: the password opens the vault (also on a new phone); a wrong one is refused', () async {
    SharedPreferences.setMockInitialValues({});
    passwordEngine();
    final first = makeState();
    await first.vault.setup('my secret');
    var latest = lastBody('POST', '/v1/vault/setup');

    // A new phone: nothing saved here, the locked key comes from the server.
    SharedPreferences.setMockInitialValues({});
    final api = ApiClient(
      baseUrl: 'http://server',
      client: MockClient((req) async {
        serverCalls.add(req);
        // The server keeps the latest locked key (a password change replaces it).
        if (req.url.path == '/v1/vault/setup') latest = jsonDecode(req.body) as Map<String, Object?>;
        if (req.url.path == '/v1/vault/recovery') return http.Response(jsonEncode(latest), 200);
        return answer(req);
      }),
    )..token = 't';
    final phone = AppState(api: api)..me = Me.fromJson(fixtures.me);
    expect(await phone.vault.state(), 'locked');
    await expectLater(phone.vault.unlockWithPassword('wrong'), throwsA(isA<VaultProblem>()));
    expect(phone.vault.isOpen, isFalse);
    await phone.vault.unlockWithPassword('my secret');
    expect(phone.vault.isOpen, isTrue);

    // Change password: the current one must be right; then only the new one opens it.
    await expectLater(phone.vault.changePassword('wrong', 'new'), throwsA(isA<VaultProblem>()));
    await phone.vault.changePassword('my secret', 'new');
    phone.vault.lock();
    await expectLater(phone.vault.unlockWithPassword('my secret'), throwsA(isA<VaultProblem>()));
    await phone.vault.unlockWithPassword('new');
    expect(phone.vault.isOpen, isTrue);
  }, timeout: const Timeout(Duration(minutes: 2)));

  test('Mere Saboot: an empty vault from the 12-word days goes straight to "Set a password"', () async {
    final tmp = Directory.systemTemp.createTempSync('legacy');
    addTearDown(() => tmp.deleteSync(recursive: true));
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(const MethodChannel('plugins.flutter.io/path_provider'), (c) async => tmp.path);
    MockClient server(int items) => MockClient((req) async {
          if (req.url.path == '/v1/vault/recovery') {
            return http.Response(
                jsonEncode({
                  'lockedKey': 'Lx',
                  'kdf': {'name': 'argon2id', 'salt': 'AAAA', 'memoryKiB': 8, 'iterations': 1, 'parallelism': 1},
                  'checkValue': 'c',
                }),
                200);
          }
          if (req.url.path == '/v1/vault/usage') return http.Response(jsonEncode({'usedBytes': 0, 'limitBytes': 1, 'items': items}), 200);
          return answer(req);
        });
    AppState phone(int items) =>
        AppState(api: ApiClient(baseUrl: 'http://server', client: server(items))..token = 't')..me = Me.fromJson(fixtures.me);
    expect(await phone(0).vault.state(), 'setup');
    SharedPreferences.setMockInitialValues({});
    expect(await phone(3).vault.state(), 'locked'); // with evidence: its old phrase is still needed
  });

  testWidgets('Mere Saboot: "Forgot password" offers a new vault only while it has no evidence', (tester) async {
    final tmp = Directory.systemTemp.createTempSync('forgot');
    addTearDown(() => tmp.deleteSync(recursive: true));
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(const MethodChannel('plugins.flutter.io/path_provider'), (c) async => tmp.path);
    var started = false;
    await tester.pumpWidget(host(makeState(), Scaffold(body: VaultUnlockView(onOpened: () async {}, onStartOver: () => started = true))));
    await tester.pumpAndSettle();
    expect(find.text('Enter your password'), findsOneWidget);
    expect(find.byKey(const Key('vault-fingerprint')), findsNothing); // not turned on for this phone
    await tester.tap(find.text('Forgot password?'));
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 200)));
    await tester.pumpAndSettle();
    expect(find.textContaining('cannot be reset'), findsOneWidget);
    await tester.tap(find.text('Start a new vault'));
    await tester.pumpAndSettle();
    expect(started, isTrue);
  });

  testWidgets('Voice SOS: the button downloads the model if needed, listens and counts the phrase', (tester) async {
    var hasModel = false;
    final results = ['heard', 'unknown:sarthi'];
    final calls = <String>[];
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(const MethodChannel('sarthi/engine'), (call) async {
      calls.add(call.method);
      switch (call.method) {
        case 'voiceHasModel':
          return hasModel;
        case 'voiceDownload':
          hasModel = true;
          return true;
        case 'voicePrepare':
          return true;
        case 'voiceTest':
          expect((call.arguments as Map)['seconds'], 10);
          return results.removeAt(0);
      }
      return null;
    });
    await tester.binding.setSurfaceSize(const Size(400, 1400));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(host(makeState(), const VoiceSetupScreen()));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField), 'please help me now');
    await tester.tap(find.byKey(const Key('voice-listen')));
    await tester.pumpAndSettle();
    // The model is loaded before "say it now", so the first words are not lost.
    expect(calls, containsAllInOrder(['voiceDownload', 'voicePrepare', 'voiceTest']));
    expect(find.text('Heard 1 of 3. Say it again.'), findsOneWidget);
    expect(find.byKey(const Key('voice-requirements')), findsOneWidget);

    await tester.tap(find.byKey(const Key('voice-listen')));
    await tester.pumpAndSettle();
    expect(find.textContaining('does not know: sarthi'), findsOneWidget);
  });

  testWidgets('Discreet mode: the widget box is on by default and can be turned off; no shortcut option', (tester) async {
    await tester.binding.setSurfaceSize(const Size(400, 1400));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(host(makeState(), const DiscreetModeScreen()));
    await tester.pumpAndSettle();
    expect(find.text('Add a shortcut'), findsNothing);
    final box = find.byKey(const Key('widget-tile'));
    expect(tester.widget<SwitchListTile>(box).value, isTrue);
    await tester.tap(box);
    await tester.pumpAndSettle();
    expect(tester.widget<SwitchListTile>(box).value, isFalse);
    final call = engineCalls.lastWhere((c) => c.method == 'setWidgetTile');
    expect(call.arguments, {'on': false});
  });

  testWidgets('Switches move at once on a slow server, and go back if the server refuses', (tester) async {
    final answers = <Completer<http.Response>>[];
    final api = ApiClient(
      baseUrl: 'http://server',
      client: MockClient((req) {
        final c = Completer<http.Response>();
        answers.add(c);
        return c.future;
      }),
    )..token = 't';
    final state = AppState(api: api)..me = Me.fromJson(fixtures.me);
    await tester.pumpWidget(host(state, const DiscreetModeScreen()));
    await tester.pump();

    bool quiet() => tester.widget<SwitchListTile>(find.widgetWithText(SwitchListTile, 'Quiet countdown')).value;
    expect(quiet(), isFalse);
    await tester.tap(find.text('Quiet countdown'));
    await tester.pump();
    expect(quiet(), isTrue); // one tap, no waiting for the server

    // The server answers OK: stays on.
    answers.removeAt(0).complete(http.Response(jsonEncode({...state.triggers.toJson(), 'quietCountdown': true}), 200));
    await tester.pump();
    expect(quiet(), isTrue);

    // Turning it off is refused by the server: it goes back on and says why.
    await tester.tap(find.text('Quiet countdown'));
    await tester.pump();
    expect(quiet(), isFalse);
    answers.removeAt(0).complete(http.Response(jsonEncode({'error': 'invalid_input', 'message': 'Not allowed now.'}), 400));
    await tester.pump();
    await tester.pump();
    expect(quiet(), isTrue);
    expect(find.text('Not allowed now.'), findsOneWidget);
  });
}
