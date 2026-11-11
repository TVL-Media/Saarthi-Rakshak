import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

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
import '../api/phase2_api.dart';
import 'vault_session.dart';
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

  /// Profile photo kept on this phone (shown even when the server has no file storage).
  Uint8List? localPhoto;

  String get _photoKey => 'profile_photo_${me?.id ?? ''}';

  Future<void> _loadLocalPhoto() async {
    final saved = (await SharedPreferences.getInstance()).getString(_photoKey);
    localPhoto = saved == null ? null : base64Decode(saved);
  }

  Future<void> setLocalPhoto(Uint8List bytes) async {
    localPhoto = bytes;
    await (await SharedPreferences.getInstance()).setString(_photoKey, base64Encode(bytes));
    notifyListeners();
  }

  /// Notifications this phone received (newest first, at most 50), for the bell on Home.
  List<AppNotice> notices = const [];

  /// When the user last opened the notifications list (the bell shows a dot for newer ones).
  DateTime? noticesSeenAt;

  bool get hasUnreadNotices => notices.isNotEmpty && (noticesSeenAt == null || notices.first.at.isAfter(noticesSeenAt!));

  String get _noticesKey => 'notices_${me?.id ?? ''}';
  String get _noticesSeenKey => 'notices_seen_${me?.id ?? ''}';

  Future<void> _loadNotices() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final raw = prefs.getString(_noticesKey);
      notices = raw == null
          ? const []
          : (jsonDecode(raw) as List).map((j) => AppNotice.fromJson(j as Map<String, dynamic>)).toList();
      final seen = prefs.getInt(_noticesSeenKey);
      noticesSeenAt = seen == null ? null : DateTime.fromMillisecondsSinceEpoch(seen);
    } catch (_) {
      notices = const [];
    }
  }

  /// Keeps a notification (a push received while the app is open, or one the user tapped).
  Future<void> addNotice(String title, String? body, {String? type, DateTime? at}) async {
    if (me == null || title.trim().isEmpty) return;
    final n = AppNotice(title: title, body: body, type: type, at: at ?? DateTime.now());
    // The same push can arrive twice (open + tapped): keep one.
    if (notices.any((o) => o.title == n.title && o.body == n.body && o.at.difference(n.at).inSeconds.abs() < 60)) return;
    notices = [n, ...notices].take(50).toList();
    notifyListeners();
    try {
      await (await SharedPreferences.getInstance())
          .setString(_noticesKey, jsonEncode(notices.map((e) => e.toJson()).toList()));
    } catch (_) {}
  }

  Future<void> markNoticesSeen() async {
    noticesSeenAt = DateTime.now();
    notifyListeners();
    try {
      await (await SharedPreferences.getInstance()).setInt(_noticesSeenKey, noticesSeenAt!.millisecondsSinceEpoch);
    } catch (_) {}
  }

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
    await _loadLocalPhoto();
    await _loadNotices();
    await engine.setSession(api.baseUrl, token, m.firstName.isEmpty ? 'Someone' : m.firstName);
    await refreshGuardians(quiet: true);
    if (m.consentGiven) await _saveSignUpName();
    stage = await _stageFor(me!);
    unawaited(registerDevice());
    unawaited(syncPhase2());
  }

  // ---- Phase 2 --------------------------------------------------------------------------------

  /// The evidence vault while it is open (the key is only in memory, for 2 minutes after the
  /// app was last used).
  late final VaultSession vault = VaultSession(this);

  /// SOS triggers (shake, voice, drive, fall, discreet) as saved on the server.
  SosTriggerSettings triggers = SosTriggerSettings();

  /// Full-day location as saved on the server.
  DailyTracking daily = DailyTracking.off;

  /// Voice SOS phrase and language: kept on this phone only (never sent anywhere).
  String voicePhrase = '';
  String voiceLang = 'en';

  /// Goes up when a voice-model download makes progress (0–100).
  final ValueNotifier<int> voiceDownload = ValueNotifier(0);

  /// A Phase 2 feature switched on by the admins (staged release); on when the server is older.
  bool feature(String name) => (me?.rules['feature.$name'] ?? 1) >= 1;

  String get _voiceKey => 'voice_${me?.id ?? ''}';

  /// Loads the Phase 2 settings and hands them to the safety engine (it keeps them across restarts).
  Future<void> syncPhase2() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final v = prefs.getStringList(_voiceKey);
      if (v != null && v.length == 2) {
        voicePhrase = v[0];
        voiceLang = v[1];
      }
      triggers = await api.sosTriggers();
      daily = await api.dailyTracking();
    } catch (_) {
      // Offline or an older server: the engine keeps what it had.
    }
    await _configureEngine();
    notifyListeners();
  }

  Future<void> _configureEngine() async {
    final rules = me?.rules ?? const {};
    num rule(String k, num d) => rules[k] ?? d;
    try {
      await engine.configure(
        triggers: {
          ...triggers.toJson(),
          'voiceOn': triggers.voiceOn && voicePhrase.isNotEmpty,
          'voicePhrase': voicePhrase,
          'voiceLang': voiceLang,
          'shakeG': rule('detection.shake_g_x10', 25) / 10,
          'crashG': rule('detection.crash_g_x10', 40) / 10,
          'fallG': rule('detection.fall_g_x10', 30) / 10,
          'countdownSeconds': rule('detection.countdown_seconds', 10),
          'featureShake': feature('shake'),
          'featureVoice': feature('voice'),
          'featureCrash': feature('crash'),
          'featureFall': feature('fall'),
        },
        daily: {
          'enabled': daily.enabled && feature('daily_location'),
          'pausedUntil': daily.pausedUntil?.millisecondsSinceEpoch ?? 0,
          'batteryPausePct': rule('daily.battery_pause_pct', 20),
        },
      );
    } catch (_) {
      // The engine is not available (e.g. tests).
    }
  }

  Future<void> saveTriggers(Map<String, Object?> change) async {
    triggers = await api.saveSosTriggers(change);
    await _configureEngine();
    notifyListeners();
  }

  Future<void> saveVoicePhrase(String phrase, String lang) async {
    voicePhrase = phrase.trim();
    voiceLang = lang;
    final prefs = await SharedPreferences.getInstance();
    await prefs.setStringList(_voiceKey, [voicePhrase, voiceLang]);
    await _configureEngine();
    notifyListeners();
  }

  Future<void> saveDaily(Map<String, Object?> change) async {
    daily = await api.saveDailyTracking(change);
    await _configureEngine();
    notifyListeners();
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
    // The photo is private: the next person to log in on this phone must not see it.
    if (me != null) {
      final prefs = await SharedPreferences.getInstance();
      prefs.remove(_photoKey).ignore();
      prefs.remove(_noticesKey).ignore();
      prefs.remove(_noticesSeenKey).ignore();
    }
    localPhoto = null;
    notices = const [];
    noticesSeenAt = null;
    triggers = SosTriggerSettings();
    daily = DailyTracking.off;
    voicePhrase = '';
    vault.lock();
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
      case 'voiceDownload':
        voiceDownload.value = (e.data['progress'] as int?) ?? 0;
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

/// One notification shown in the Notifications list.
class AppNotice {
  AppNotice({required this.title, this.body, this.type, required this.at});
  final String title;
  final String? body;

  /// The push type from the server (guardian_status, show_call_112, checkin_no_reply).
  final String? type;
  final DateTime at;

  factory AppNotice.fromJson(Map<String, dynamic> j) => AppNotice(
        title: j['title'] as String,
        body: j['body'] as String?,
        type: j['type'] as String?,
        at: DateTime.fromMillisecondsSinceEpoch(j['at'] as int),
      );

  Map<String, dynamic> toJson() => {'title': title, 'body': body, 'type': type, 'at': at.millisecondsSinceEpoch};
}
