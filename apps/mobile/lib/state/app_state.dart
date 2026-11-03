import 'dart:async';

import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:permission_handler/permission_handler.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:uuid/uuid.dart';

import '../api/api_client.dart';
import '../api/models.dart';
import '../config.dart';
import '../engine/engine.dart';

const _uuid = Uuid();

/// Where the app should be: decided from the session and the user's setup.
enum Stage { loading, welcome, login, consent, profile, guardians, safetySetup, home }

/// App-wide state: session, the user, guardians, and the bridge to the safety engine.
class AppState extends ChangeNotifier {
  AppState({ApiClient? api, SafetyEngine? engine, FlutterSecureStorage? storage})
      : api = api ?? ApiClient(),
        engine = engine ?? SafetyEngine(),
        _storage = storage ?? const FlutterSecureStorage() {
    this.api.onSessionEnded = () => unawaited(_endLocally());
  }

  final ApiClient api;
  final SafetyEngine engine;
  final FlutterSecureStorage _storage;

  Stage stage = Stage.loading;
  Me? me;
  List<Guardian> guardians = const [];
  EngineState engineState = EngineState.idle;
  StreamSubscription<EngineEvent>? _events;

  /// Pending "open the SOS countdown / check-in" request from the widget, tile or a notification.
  final ValueNotifier<Map<dynamic, dynamic>?> launchAction = ValueNotifier(null);

  /// The check-in the engine asks the user to answer (null when none).
  final ValueNotifier<Map<dynamic, dynamic>?> checkinAlert = ValueNotifier(null);

  /// Goes up each time a recording finished playing.
  final ValueNotifier<int> playbackDone = ValueNotifier(0);

  static const _tokenKey = 'session_token';
  static const _seenWelcomeKey = 'seen_welcome';
  static const _setupDoneKey = 'setup_done';
  static const _deviceIdKey = 'device_id';

  Future<void> start() async {
    _events = engine.events.listen(_onEngineEvent, onError: (_) {});
    final prefs = await SharedPreferences.getInstance();
    final token = await _storage.read(key: _tokenKey);
    if (token == null) {
      stage = (prefs.getBool(_seenWelcomeKey) ?? false) ? Stage.login : Stage.welcome;
      notifyListeners();
      return;
    }
    api.token = token;
    try {
      me = await api.me();
      await _afterLogin(token);
    } on ApiException catch (e) {
      if (e.notLoggedIn) {
        await _endLocally();
        return;
      }
      // Offline: keep the user in; the engine still works without internet.
      stage = Stage.home;
    }
    await _refreshEngineState();
    _takeLaunchAction();
    notifyListeners();
  }

  Future<void> markWelcomeSeen() async {
    (await SharedPreferences.getInstance()).setBool(_seenWelcomeKey, true);
    stage = Stage.login;
    notifyListeners();
  }

  /// Name typed on the Sign up page; saved once the user has accepted the terms.
  String? _signUpName;

  /// After Firebase confirmed the OTP. [signUpName]: from the Sign up page.
  Future<void> loginWithFirebaseToken(String idToken, {String? signUpName}) async {
    _signUpName = signUpName;
    final (token, user, _) = await api.login(idToken);
    api.token = token;
    me = user;
    await _storage.write(key: _tokenKey, value: token);
    await _afterLogin(token);
    notifyListeners();
  }

  /// Development only (debug builds with DEV_LOGIN): the server's test number and code.
  Future<void> loginWithDevCode(String phone, String code, {String? signUpName}) async {
    _signUpName = signUpName;
    final (token, user, _) = await api.devLogin(phone, code);
    api.token = token;
    me = user;
    await _storage.write(key: _tokenKey, value: token);
    await _afterLogin(token);
    notifyListeners();
  }

  Future<void> _afterLogin(String token) async {
    final m = me!;
    await engine.setSession(api.baseUrl, token, m.firstName.isEmpty ? 'Someone' : m.firstName);
    await refreshGuardians(quiet: true);
    if (m.consentGiven) await _saveSignUpName();
    stage = await _stageFor(me!);
    unawaited(registerDevice());
  }

  /// Saves the Sign up name if the account has no name yet (needs the terms accepted first).
  Future<void> _saveSignUpName() async {
    final name = _signUpName?.trim();
    _signUpName = null;
    if (name == null || name.isEmpty || (me?.name ?? '').trim().isNotEmpty) return;
    try {
      me = await api.updateProfile(name: name);
      await engine.setSession(api.baseUrl, api.token!, me!.firstName);
    } on ApiException {
      // The profile step asks for the name instead.
    }
  }

  Future<Stage> _stageFor(Me m) async {
    if (!m.consentGiven) return Stage.consent;
    if ((m.name ?? '').trim().isEmpty) return Stage.profile;
    final done = (await SharedPreferences.getInstance()).getBool(_setupDoneKey) ?? false;
    if (done) return Stage.home;
    if (m.guardiansCount == 0) return Stage.guardians;
    return Stage.safetySetup;
  }

  Future<void> giveConsent() async {
    me = await api.giveConsent();
    await _saveSignUpName();
    stage = await _stageFor(me!);
    notifyListeners();
  }

  Future<void> profileSaved(Me updated) async {
    me = updated;
    await engine.setSession(api.baseUrl, api.token!, updated.firstName);
    if (stage == Stage.profile) stage = await _stageFor(updated);
    notifyListeners();
  }

  void guardiansStepDone() {
    stage = Stage.safetySetup;
    notifyListeners();
  }

  Future<void> setupDone() async {
    (await SharedPreferences.getInstance()).setBool(_setupDoneKey, true);
    stage = Stage.home;
    notifyListeners();
  }

  Future<void> refreshMe() async {
    try {
      me = await api.me();
      notifyListeners();
    } on ApiException {
      // keep the last known
    }
  }

  Future<void> refreshGuardians({bool quiet = false}) async {
    try {
      guardians = await api.guardians();
      await engine.cacheGuardians(guardians);
      if (!quiet) notifyListeners();
    } on ApiException {
      if (!quiet) rethrow;
    }
  }

  /// Phone details, permissions and push token for the server (admin "Setup complete").
  Future<void> registerDevice() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      var deviceId = prefs.getString(_deviceIdKey);
      if (deviceId == null) {
        deviceId = _uuid.v4();
        await prefs.setString(_deviceIdKey, deviceId);
      }
      final info = await engine.deviceInfo();
      String? pushToken;
      if (Firebase.apps.isNotEmpty) {
        // getToken (registration token) is what the server's firebase-admin send() expects.
        // ignore: deprecated_member_use
        pushToken = await FirebaseMessaging.instance.getToken().timeout(const Duration(seconds: 10));
      }
      await api.saveDevice({
        'deviceId': deviceId,
        'model': (info['model'] as String?) ?? 'Android',
        'androidVersion': (info['androidVersion'] as String?) ?? '?',
        'appVersion': (info['appVersion'] as String?) ?? '?',
        'pushToken': pushToken,
        'permissions': {
          'location': await Permission.locationAlways.isGranted || await Permission.location.isGranted,
          'notifications': await Permission.notification.isGranted,
          'sms': await Permission.sms.isGranted,
          'microphone': await Permission.microphone.isGranted,
        },
        'batteryOptimisationOff': await engine.batteryOptimisationOff(),
      });
    } catch (e) {
      debugPrint('Device details not sent: $e');
    }
  }

  Future<void> logout() async {
    try {
      await api.logout();
    } on ApiException {
      // ending locally is enough
    }
    await _endLocally();
  }

  /// After "Delete my account" succeeded.
  Future<void> accountDeleted() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.clear();
    await _endLocally(toWelcome: true);
  }

  Future<void> _endLocally({bool toWelcome = false}) async {
    await _storage.delete(key: _tokenKey);
    api.token = null;
    me = null;
    guardians = const [];
    try {
      await engine.clearSession();
    } catch (_) {}
    stage = toWelcome ? Stage.welcome : Stage.login;
    notifyListeners();
  }

  void _onEngineEvent(EngineEvent e) {
    switch (e.type) {
      case 'state':
        engineState = EngineState(e.data);
        notifyListeners();
      case 'checkin':
        checkinAlert.value = e.data;
      case 'launch':
        launchAction.value = e.data;
      case 'playback':
        playbackDone.value++;
    }
  }

  Future<void> _refreshEngineState() async {
    try {
      engineState = await engine.state();
    } catch (_) {}
  }

  Future<void> _takeLaunchAction() async {
    try {
      final action = await engine.takeLaunchAction();
      if (action != null) launchAction.value = action;
    } catch (_) {}
  }

  String newId() => _uuid.v4();

  @override
  void dispose() {
    _events?.cancel();
    super.dispose();
  }
}

/// Gives every screen access to [AppState].
class AppScope extends InheritedNotifier<AppState> {
  const AppScope({super.key, required AppState state, required super.child}) : super(notifier: state);

  static AppState of(BuildContext context) => context.dependOnInheritedWidgetOfExactType<AppScope>()!.notifier!;

  static AppState read(BuildContext context) => context.getInheritedWidgetOfExactType<AppScope>()!.notifier!;
}

bool get firebaseReady => AppConfig.firebaseConfigured && Firebase.apps.isNotEmpty;
