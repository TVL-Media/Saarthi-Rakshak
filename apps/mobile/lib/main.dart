import 'dart:async';

import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/material.dart';

import 'config.dart';
import 'screens/auth/consent_screen.dart';
import 'screens/auth/login_screen.dart';
import 'screens/auth/profile_screen.dart';
import 'screens/fakecall/fake_call_screen.dart';
import 'screens/guardians/guardians_screen.dart';
import 'screens/home/shell.dart';
import 'screens/journey/checkin_screen.dart';
import 'screens/notifications/notifications_screen.dart';
import 'screens/onboarding/welcome_screen.dart';
import 'screens/setup/safety_setup_screen.dart';
import 'screens/vault/share_import_screen.dart';
import 'state/app_state.dart';
import 'theme.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  if (AppConfig.firebaseConfigured) {
    try {
      await Firebase.initializeApp(
        options: const FirebaseOptions(
          apiKey: AppConfig.firebaseApiKey,
          appId: AppConfig.firebaseAppId,
          messagingSenderId: AppConfig.firebaseSenderId,
          projectId: AppConfig.firebaseProjectId,
        ),
      );
    } catch (e) {
      debugPrint('Firebase not started: $e');
    }
  }
  final state = AppState();
  runApp(SarthiApp(state: state));
  unawaited(state.start());
}

final navigatorKey = GlobalKey<NavigatorState>();

class SarthiApp extends StatelessWidget {
  const SarthiApp({super.key, required this.state});
  final AppState state;

  @override
  Widget build(BuildContext context) {
    return AppScope(
      state: state,
      child: MaterialApp(
        title: 'Sarthi Rakshak',
        debugShowCheckedModeBanner: false,
        theme: buildTheme(),
        navigatorKey: navigatorKey,
        home: const _Root(),
      ),
    );
  }
}

/// Shows the screen for the current stage, and opens the SOS countdown or check-in on request
/// (from the widget, quick tile, a notification or the engine).
class _Root extends StatefulWidget {
  const _Root();

  @override
  State<_Root> createState() => _RootState();
}

class _RootState extends State<_Root> {
  StreamSubscription<RemoteMessage>? _push;
  StreamSubscription<RemoteMessage>? _opened;
  bool _checkinOpen = false;
  late final AppState _state = AppScope.read(context);

  @override
  void initState() {
    super.initState();
    final state = _state;
    state.launchAction.addListener(_onLaunch);
    state.checkinAlert.addListener(_onCheckin);
    if (firebaseReady) {
      FirebaseMessaging.instance.requestPermission().ignore();
      _push = FirebaseMessaging.onMessage.listen(_onPush);
      // A notification tapped while the app was in the background: keep it in the bell's list.
      _opened = FirebaseMessaging.onMessageOpenedApp.listen((m) {
        _keepNotice(m);
        _openNoticePage(m.data['type'] as String?);
      });
    }
  }

  @override
  void dispose() {
    final state = _state;
    state.launchAction.removeListener(_onLaunch);
    state.checkinAlert.removeListener(_onCheckin);
    _push?.cancel();
    _opened?.cancel();
    super.dispose();
  }

  void _onLaunch() {
    final state = AppScope.read(context);
    final action = state.launchAction.value;
    if (action == null || state.stage != Stage.home) return;
    state.launchAction.value = null;
    final ctx = navigatorKey.currentContext;
    if (ctx == null) return;
    switch (action['action']) {
      case 'sos':
        openSos(
          ctx,
          trigger: (action['trigger'] as String?) ?? 'widget',
          quiet: action['quiet'] == null ? null : action['quiet'] == 'true',
          seconds: int.tryParse('${action['seconds'] ?? ''}'),
          heightM: action['heightM'] as String?,
        );
      case 'share':
        // Android Share → Sarthi Rakshak: save the files to the vault.
        Navigator.of(ctx).push(MaterialPageRoute(
          builder: (_) => ShareImportScreen(
            files: ((action['files'] as List?) ?? const [])
                .map((f) => SharedFile.fromMap(f as Map))
                .toList(),
          ),
        ));
      case 'checkin':
        state.checkinAlert.value = action;
      case 'fakecall':
        // A scheduled fake call came due (app on screen, or its call notification was tapped).
        openFakeCall(ctx, (action['caller'] as String?) ?? 'Mom', answered: action['answered'] == 'true');
    }
  }

  void _onCheckin() {
    final a = AppScope.read(context).checkinAlert.value;
    if (a == null || _checkinOpen) return;
    _checkinOpen = true;
    navigatorKey.currentState!
        .push(MaterialPageRoute(
          fullscreenDialog: true,
          builder: (_) => CheckinScreen(
            checkinId: a['checkinId'] as String?,
            reason: (a['reason'] as String?) ?? 'stopped',
            journeyId: a['journeyId'] as String?,
            preview: (a['preview'] as bool?) ?? false,
          ),
        ))
        .whenComplete(() => _checkinOpen = false);
  }

  /// Push while the app is open: show it as a message (closed apps get the system notification).
  void _onPush(RemoteMessage m) {
    _keepNotice(m);
    final ctx = navigatorKey.currentContext;
    final title = m.notification?.title;
    if (ctx == null || title == null) return;
    ScaffoldMessenger.of(ctx).showSnackBar(SnackBar(content: Text(title)));
    if (m.data['type'] == 'guardian_status') AppScope.read(context).refreshGuardians(quiet: true);
  }

  /// A tapped Phase 2 notification (community report, Rakshak, plan) opens its page.
  void _openNoticePage(String? type) {
    final page = noticePage(type);
    final nav = navigatorKey.currentState;
    if (page == null || nav == null || _state.stage != Stage.home) return;
    nav.push(MaterialPageRoute(builder: (_) => page));
  }

  void _keepNotice(RemoteMessage m) {
    final title = m.notification?.title;
    if (title == null) return;
    _state.addNotice(title, m.notification?.body, type: m.data['type'] as String?, at: m.sentTime);
  }

  @override
  Widget build(BuildContext context) {
    final state = AppScope.of(context);
    // A launch request that arrived before login finished is handled once we reach Home.
    if (state.stage == Stage.home && state.launchAction.value != null) {
      WidgetsBinding.instance.addPostFrameCallback((_) => _onLaunch());
    }
    return switch (state.stage) {
      Stage.loading => const Scaffold(body: Center(child: CircularProgressIndicator())),
      Stage.welcome => const WelcomeScreen(),
      Stage.login => const LoginScreen(),
      Stage.consent => const ConsentScreen(),
      Stage.profile => const ProfileScreen(),
      Stage.guardians => const GuardiansScreen(setupStep: true),
      Stage.safetySetup => const SafetySetupScreen(setupStep: true),
      Stage.home => const Shell(),
    };
  }
}
