import 'dart:async';

import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/material.dart';

import 'config.dart';
import 'screens/auth/consent_screen.dart';
import 'screens/auth/login_screen.dart';
import 'screens/auth/profile_screen.dart';
import 'screens/guardians/guardians_screen.dart';
import 'screens/home/shell.dart';
import 'screens/journey/checkin_screen.dart';
import 'screens/onboarding/welcome_screen.dart';
import 'screens/setup/safety_setup_screen.dart';
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
  bool _checkinOpen = false;

  @override
  void initState() {
    super.initState();
    final state = AppScope.read(context);
    state.launchAction.addListener(_onLaunch);
    state.checkinAlert.addListener(_onCheckin);
    if (firebaseReady) {
      FirebaseMessaging.instance.requestPermission().ignore();
      _push = FirebaseMessaging.onMessage.listen(_onPush);
    }
  }

  @override
  void dispose() {
    final state = AppScope.read(context);
    state.launchAction.removeListener(_onLaunch);
    state.checkinAlert.removeListener(_onCheckin);
    _push?.cancel();
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
        openSos(ctx, trigger: (action['trigger'] as String?) ?? 'widget');
      case 'checkin':
        state.checkinAlert.value = action;
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
    final ctx = navigatorKey.currentContext;
    final title = m.notification?.title;
    if (ctx == null || title == null) return;
    ScaffoldMessenger.of(ctx).showSnackBar(SnackBar(content: Text(title)));
    if (m.data['type'] == 'guardian_status') AppScope.read(context).refreshGuardians(quiet: true);
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
