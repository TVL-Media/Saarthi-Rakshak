import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:sarthi_rakshak/api/api_client.dart';
import 'package:sarthi_rakshak/api/models.dart';
import 'package:sarthi_rakshak/screens/auth/profile_screen.dart';
import 'package:sarthi_rakshak/screens/community/community_screen.dart';
import 'package:sarthi_rakshak/screens/community/rakshak_screen.dart';
import 'package:sarthi_rakshak/screens/daily/daily_location_screen.dart';
import 'package:sarthi_rakshak/screens/fakecall/fake_call_screen.dart';
import 'package:sarthi_rakshak/screens/guardians/guardians_screen.dart';
import 'package:sarthi_rakshak/screens/history/history_screen.dart';
import 'package:sarthi_rakshak/screens/home/shell.dart';
import 'package:sarthi_rakshak/screens/journey/start_journey_screen.dart';
import 'package:sarthi_rakshak/screens/legal/legal_screen.dart';
import 'package:sarthi_rakshak/screens/notifications/notifications_screen.dart';
import 'package:sarthi_rakshak/screens/settings/plans_screen.dart';
import 'package:sarthi_rakshak/screens/settings/settings_screen.dart';
import 'package:sarthi_rakshak/screens/settings/sos_triggers_screen.dart';
import 'package:sarthi_rakshak/screens/setup/safety_setup_screen.dart';
import 'package:sarthi_rakshak/screens/sos/recordings_screen.dart';
import 'package:sarthi_rakshak/screens/vault/evidence_screens.dart';
import 'package:sarthi_rakshak/screens/vault/vault_screen.dart';
import 'package:sarthi_rakshak/screens/vault/vault_setup_screen.dart';
import 'package:sarthi_rakshak/state/app_state.dart';
import 'package:sarthi_rakshak/state/vault_session.dart';
import 'package:sarthi_rakshak/theme.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'api_client_test.dart' as fixtures;

// Every menu, card and row opens the screen it names, and Back returns (Phase 1 + Phase 2).

final now = DateTime.now().toUtc();
String iso(Duration ago) => now.subtract(ago).toIso8601String();
String locked(Map<String, Object?> j) => 'L${base64Encode(utf8.encode(jsonEncode(j)))}';

final guardians = [
  {'id': 'g1', 'name': 'Reena Sharma', 'relation': 'Sister', 'phoneMasked': 'x', 'phone': '+919876543210', 'status': 'accepted'},
];
final evidence = [
  {
    'id': 'e1', 'kind': 'audio', 'incidentId': null, 'lockedFileKey': 'L', 'lockedDetails': locked({'note': 'From the metro', 'fileName': 'Recording.m4a'}),
    'sha256': 'ab' * 32, 'capturedAt': iso(const Duration(hours: 5)), 'receivedAt': iso(const Duration(hours: 5)), 'sizeBytes': 1834000,
    'hasFile': true, 'uploaded': true, 'hidden': false, 'deleteLockedUntil': now.add(const Duration(days: 89)).toIso8601String(),
  },
];
final incidents = [
  {
    'id': 'i1', 'kind': 'harassment', 'lockedDetails': locked({'title': 'Calls at night', 'date': iso(const Duration(days: 2)), 'description': 'Unknown number'}),
    'sosId': null, 'itemsCount': 0, 'createdAt': iso(const Duration(days: 2)), 'updatedAt': iso(const Duration(days: 1)),
  },
];

http.Response answer(http.Request req) {
  final p = req.url.path;
  http.Response j(Object o, [int s = 200]) => http.Response(jsonEncode(o), s, headers: {'content-type': 'application/json; charset=utf-8'});
  return switch (p) {
    '/v1/me' => j(fixtures.me),
    '/v1/guardians' => j(guardians),
    '/v1/places' => j([]),
    '/v1/history' => j({'items': [], 'nextCursor': null}),
    '/v1/me/sos-triggers' => j({'shakeMode': 'off', 'voiceOn': false, 'driveMode': false, 'fallOn': false, 'quietCountdown': false, 'journeySosButton': true}),
    '/v1/me/daily-tracking' => j({'enabled': false, 'pausedUntil': null, 'retentionDays': 30, 'consentVersion': null}),
    '/v1/timeline' => j({'date': '2026-11-11', 'stops': [], 'routes': [], 'pointsCount': 0}),
    '/v1/vault/recovery' => j({'lockedKey': 'L', 'kdf': {}, 'checkValue': 'c'}),
    '/v1/vault/items' => j(evidence),
    '/v1/vault/incidents' => j(incidents),
    '/v1/vault/usage' => j({'usedBytes': 1834000, 'limitBytes': 1 << 30, 'items': 1}),
    '/v1/vault/access-log' => j([]),
    '/v1/community/areas' => j({'areas': ['Sector 18', 'Sector 62']}),
    '/v1/community/posts' => j([]),
    '/v1/community/my-reports' => j([]),
    '/v1/rakshak/application' => j({'application': null}),
    '/v1/plans' => j({'plans': [], 'current': 'basic', 'everythingFree': true, 'renewsAt': null}),
    _ => http.Response('', 204),
  };
}

AppState makeState() {
  final s = AppState(api: ApiClient(baseUrl: 'http://s', client: MockClient((r) async => answer(r)))..token = 't')
    ..me = Me.fromJson({...fixtures.me, 'guardiansCount': 1, 'acceptedGuardiansCount': 1})
    ..guardians = guardians.map(Guardian.fromJson).toList()
    ..stage = Stage.home;
  return s;
}

void main() {
  late Directory tmp;
  setUp(() {
    SharedPreferences.setMockInitialValues({});
    FlutterSecureStorage.setMockInitialValues({});
    VaultSession.testAuth = (_) async => true;
    tmp = Directory.systemTemp.createTempSync('nav');
    final m = TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    m.setMockMethodCallHandler(const MethodChannel('sarthi/engine'), (c) async {
      final a = (c.arguments as Map?) ?? const {};
      return switch (c.method) {
        'getState' => {'mode': 'idle'},
        'deviceInfo' => {'manufacturer': 'Google', 'model': 'Pixel'},
        'vaultExists' => true,
        'vaultUnlock' => base64Encode(List.filled(32, 7)),
        'vaultDecrypt' => (a['locked'] as String).substring(1),
        'vaultEncrypt' => 'L${a['plain']}',
        'voiceHasModel' => false,
        'listClips' => [],
        'batteryOptimisationOff' => true,
        _ => null,
      };
    });
    m.setMockMethodCallHandler(const MethodChannel('plugins.flutter.io/path_provider'), (c) async => tmp.path);
    m.setMockMethodCallHandler(const MethodChannel('com.llfbandit.record/messages'), (c) async => null);
    for (final n in ['flutter.baseflow.com/geolocator_android', 'flutter.baseflow.com/geolocator']) {
      m.setMockMethodCallHandler(MethodChannel(n), (c) async => switch (c.method) {
            'isLocationServiceEnabled' => true,
            'checkPermission' => 3,
            _ => null,
          });
    }
    m.setMockMethodCallHandler(const MethodChannel('flutter.baseflow.com/permissions/methods'),
        (c) async => c.method == 'checkPermissionStatus' ? 1 : (c.method == 'requestPermissions' ? <int, int>{} : true));
  });
  tearDown(() => VaultSession.testAuth = null);

  Future<void> settle(WidgetTester t) async {
    for (var i = 0; i < 6; i++) {
      await t.pump(const Duration(milliseconds: 250));
    }
  }

  Future<void> start(WidgetTester t, Widget home) async {
    await t.binding.setSurfaceSize(const Size(420, 2400));
    addTearDown(() => t.binding.setSurfaceSize(null));
    await t.pumpWidget(AppScope(state: makeState(), child: MaterialApp(theme: buildTheme(), home: home)));
    await settle(t);
  }

  /// Taps [target], expects [screen] on top, then goes back and expects [back] again.
  Future<void> opens(WidgetTester t, Finder target, Type screen, {Type? back, bool goBack = true}) async {
    expect(target, findsWidgets, reason: 'nothing to tap for $screen');
    await t.ensureVisible(target.first);
    await t.pump();
    await t.tap(target.first);
    await settle(t);
    expect(t.takeException(), isNull, reason: 'error while opening $screen');
    expect(find.byType(screen), findsWidgets, reason: '$target should open $screen');
    if (!goBack) return;
    final nav = t.state<NavigatorState>(find.byType(Navigator).last);
    nav.pop();
    await settle(t);
    expect(t.takeException(), isNull, reason: 'error after leaving $screen');
    if (back != null) expect(find.byType(back), findsWidgets, reason: 'Back from $screen');
  }

  testWidgets('Menu: every item opens its page', (t) async {
    await start(t, const Shell());
    Future<void> menu(String label, Type screen, {bool tab = false}) async {
      await t.tap(find.byTooltip('Menu'));
      await settle(t);
      await t.tap(find.descendant(of: find.byType(Drawer), matching: find.text(label)));
      await settle(t);
      expect(t.takeException(), isNull, reason: 'menu $label');
      expect(find.byType(screen), findsWidgets, reason: 'menu $label');
      if (!tab) {
        t.state<NavigatorState>(find.byType(Navigator).last).pop();
        await settle(t);
      }
      // Back on Home for the next item.
      await t.tap(find.text('Home').last);
      await settle(t);
    }

    await menu('Fake Call', FakeCallScreen);
    await menu('Saved Places', SavedPlacesScreen);
    await menu('Mere Saboot', VaultScreen);
    await menu('My Timeline', TimelineScreen);
    await menu('Community', CommunityScreen);
    await menu('Become a Rakshak', RakshakScreen);
    await menu('Safety Setup', SafetySetupScreen);
    await menu('Help & Support', ReportProblemScreen);
    await menu('My Journeys', HistoryScreen, tab: true);
    await menu('Guardians', GuardiansScreen, tab: true);
    await menu('Settings', SettingsScreen, tab: true);
  });

  testWidgets('Home: bell, cards and buttons open the right pages', (t) async {
    await start(t, const Shell());
    await opens(t, find.byTooltip('Notifications'), NotificationsScreen, back: Shell);
    await opens(t, find.byKey(const Key('home-vault')), VaultScreen, back: Shell);
    await opens(t, find.byKey(const Key('home-daily')), DailyLocationScreen, back: Shell);
    await opens(t, find.byKey(const Key('home-community')), CommunityScreen, back: Shell);
    await opens(t, find.text('Fake call'), FakeCallScreen, back: Shell);
    await opens(t, find.text('Start journey'), StartJourneyScreen, back: Shell);
  });

  testWidgets('Settings: every row opens its page', (t) async {
    await start(t, const Shell());
    await t.tap(find.text('Settings').last);
    await settle(t);
    await opens(t, find.text('Priya Sharma').first, ProfileScreen, back: SettingsScreen);
    for (final (label, screen) in [
      ('Safety Setup', SafetySetupScreen),
      ('My Recordings', RecordingsScreen),
      ('Saved Places', SavedPlacesScreen),
      ('SOS Triggers', SosTriggersScreen),
      ('Full-day Location', DailyLocationScreen),
      ('Mere Saboot', VaultScreen),
      ('Plans', PlansScreen),
      ('Privacy Policy', LegalScreen),
      ('Terms & Conditions', LegalScreen),
      ('Help & Support', ReportProblemScreen),
      ('Delete My Account', DeleteAccountScreen),
    ]) {
      await opens(t, find.text(label), screen, back: SettingsScreen);
    }
    await opens(t, find.descendant(of: find.byType(SettingsScreen), matching: find.text('Guardians')), GuardiansScreen);
  });

  testWidgets('Phase 2 pages: inner links', (t) async {
    await start(t, const SosTriggersScreen());
    await opens(t, find.text('Say your own phrase'), VoiceSetupScreen, back: SosTriggersScreen);
    await opens(t, find.text('Discreet mode').last, DiscreetModeScreen, back: SosTriggersScreen);

    await start(t, const DailyLocationScreen());
    await opens(t, find.text('My timeline'), TimelineScreen, back: DailyLocationScreen);

    await start(t, const CommunityScreen());
    await opens(t, find.byKey(const Key('community-report')), CommunityReportScreen, back: CommunityScreen);
    await opens(t, find.byTooltip('My reports'), MyReportsScreen, back: CommunityScreen);

    await start(t, const RakshakScreen());
    await opens(t, find.byKey(const Key('rakshak-apply')), RakshakFormScreen, back: RakshakScreen);
  });

  testWidgets('Mere Saboot: every action and row opens its page', (t) async {
    await start(t, const VaultScreen());
    expect(find.text('Calls at night'), findsOneWidget);
    await opens(t, find.text('Record audio'), AudioRecorderScreen, back: VaultScreen);
    await opens(t, find.text('Add details'), AddDetailScreen, back: VaultScreen);
    await opens(t, find.text('New incident'), IncidentFormScreen, back: VaultScreen);
    await opens(t, find.text('Calls at night'), IncidentScreen, goBack: false);
    await opens(t, find.byTooltip('Edit'), IncidentFormScreen, back: IncidentScreen);
    t.state<NavigatorState>(find.byType(Navigator).last).pop();
    await settle(t);
    await opens(t, find.text('Recording.m4a'), EvidenceItemScreen, back: VaultScreen);
    await opens(t, find.text('Access history'), AccessHistoryScreen, back: VaultScreen);
    await opens(t, find.text('Recovery phrase'), NewPhraseScreen, back: VaultScreen);
  });

  testWidgets('Notifications about reports, Rakshak and plans open their page', (t) async {
    final state = makeState();
    state.addNotice('Your report is published', 'Thank you.', type: 'community_status');
    state.addNotice('Your Rakshak application was not approved', 'Reason: blurry ID', type: 'rakshak_status');
    state.addNotice('Your plan has ended', null, type: 'plan_status');
    await t.binding.setSurfaceSize(const Size(420, 2400));
    addTearDown(() => t.binding.setSurfaceSize(null));
    await t.pumpWidget(AppScope(state: state, child: MaterialApp(theme: buildTheme(), home: const NotificationsScreen())));
    await settle(t);
    await opens(t, find.text('Your report is published'), MyReportsScreen, back: NotificationsScreen);
    await opens(t, find.text('Your Rakshak application was not approved'), RakshakScreen, back: NotificationsScreen);
    await opens(t, find.text('Your plan has ended'), PlansScreen, back: NotificationsScreen);
  });

  testWidgets('Forms say what is missing instead of sending', (t) async {
    await start(t, const CommunityReportScreen(areas: ['Sector 62']));
    await t.tap(find.text('Send report'));
    await settle(t);
    expect(find.text('Choose the area.'), findsOneWidget);

    await start(t, const RakshakFormScreen());
    await t.tap(find.text('Send application'));
    await settle(t);
    expect(find.text('You must be 18 or older.'), findsOneWidget);

    await start(t, const AddDetailScreen(incidents: [], incidentDetails: {}));
    await t.tap(find.text('Save'));
    await settle(t);
    expect(find.text('Enter the phone number.'), findsOneWidget);
  });

  testWidgets('Back on Home: the first press asks, the second press within 2 s leaves the app', (t) async {
    final calls = <String>[];
    t.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, (c) async {
      calls.add(c.method);
      return null;
    });
    await start(t, const Shell());
    await t.binding.handlePopRoute();
    await t.pump();
    expect(find.text('Press back again to exit'), findsOneWidget);
    expect(calls, isNot(contains('SystemNavigator.pop')));
    await t.binding.handlePopRoute();
    await t.pump();
    expect(calls, contains('SystemNavigator.pop'));

    // On another tab, Back goes to Home first (the app stays open).
    calls.clear();
    await t.pump(const Duration(seconds: 3));
    await t.tap(find.text('Settings').last);
    await settle(t);
    await t.binding.handlePopRoute();
    await settle(t);
    expect(find.byType(SettingsScreen).hitTestable(), findsNothing);
    expect(calls, isNot(contains('SystemNavigator.pop')));
  });

  testWidgets('Log out ends at once, even when the server does not answer', (t) async {
    final api = ApiClient(baseUrl: 'http://s', client: MockClient((r) => Completer<http.Response>().future))..token = 't';
    final state = AppState(api: api)
      ..me = Me.fromJson(fixtures.me)
      ..stage = Stage.home;
    await t.runAsync(() => state.logout().timeout(const Duration(seconds: 3)));
    expect(state.stage, Stage.login);
    expect(api.token, isNull);
  });
}
