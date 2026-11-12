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

  testWidgets('Mere Saboot: set up with 12 words, 3 checked; a wrong word is refused', (tester) async {
    await tester.binding.setSurfaceSize(const Size(400, 1800));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(host(makeState(), const VaultScreen()));
    await tester.pumpAndSettle();
    expect(find.text(vaultTagline), findsOneWidget);
    await tester.tap(find.text('Show my 12 words'));
    await tester.pumpAndSettle();

    // Read the words from the grid: "N." followed by the word.
    final texts = tester
        .widgetList<Text>(find.descendant(of: find.byType(PhraseGrid), matching: find.byType(Text)))
        .map((t) => t.data!)
        .toList();
    final words = <int, String>{};
    for (var i = 0; i < texts.length - 1; i++) {
      final m = RegExp(r'^(\d+)\.$').firstMatch(texts[i]);
      if (m != null) words[int.parse(m.group(1)!)] = texts[i + 1];
    }
    expect(words.length, 12);

    await tester.tap(find.text('I have written them down'));
    await tester.pumpAndSettle();
    int asked(int k) {
      final field = tester.widget<TextField>(find.byKey(Key('check-word-$k')));
      return int.parse(field.decoration!.labelText!.replaceAll('Word ', ''));
    }

    await tester.enterText(find.byKey(const Key('check-word-0')), 'wrong');
    await tester.enterText(find.byKey(const Key('check-word-1')), words[asked(1)]!);
    await tester.enterText(find.byKey(const Key('check-word-2')), words[asked(2)]!);
    await tester.tap(find.text('Set up my vault'));
    await tester.pumpAndSettle();
    expect(find.textContaining('is not right'), findsOneWidget);
    expect(serverCalls.where((r) => r.url.path == '/v1/vault/setup'), isEmpty);

    await tester.enterText(find.byKey(const Key('check-word-0')), words[asked(0)]!);
    // Argon2id runs for real (a few seconds), outside the test's fake clock.
    await tester.runAsync(() async {
      await tester.tap(find.text('Set up my vault'));
      for (var i = 0; i < 60 && !serverCalls.any((r) => r.url.path == '/v1/vault/usage'); i++) {
        await Future<void>.delayed(const Duration(milliseconds: 500));
      }
    });
    await tester.pumpAndSettle();
    final setup = lastBody('POST', '/v1/vault/setup');
    expect((setup['kdf'] as Map)['name'], 'argon2id');
    // The vault key is locked with a key made from the phrase (Argon2id), not sent as it is.
    final vaultKey = base64Encode(List.filled(32, 7));
    final lock = engineCalls.firstWhere((c) => c.method == 'vaultEncrypt');
    expect((lock.arguments as Map)['plain'], vaultKey);
    expect((lock.arguments as Map)['key'], isNot(vaultKey));
    expect(setup['lockedKey'], 'L$vaultKey'); // what the fake engine returned for that lock
    expect(setup.containsKey('key'), isFalse);
    expect(engineCalls.any((c) => c.method == 'vaultStore'), isTrue);
    expect(find.text('Add evidence'.toUpperCase()), findsOneWidget);
  }, timeout: const Timeout(Duration(minutes: 2)));

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
}
