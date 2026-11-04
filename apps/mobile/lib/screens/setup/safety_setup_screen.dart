import 'package:flutter/material.dart';
import 'package:permission_handler/permission_handler.dart';

import '../../state/app_state.dart';
import '../../theme.dart';
import '../../widgets/common.dart';

/// Battery-saving steps per phone brand (the brand is read from the phone).
const batteryGuides = <String, String>{
  'xiaomi': 'Settings → Apps → Manage apps → Sarthi Rakshak → Battery saver → No restrictions. Also turn on Autostart.',
  'redmi': 'Settings → Apps → Manage apps → Sarthi Rakshak → Battery saver → No restrictions. Also turn on Autostart.',
  'poco': 'Settings → Apps → Manage apps → Sarthi Rakshak → Battery saver → No restrictions. Also turn on Autostart.',
  'samsung': 'Settings → Battery → Background usage limits → Never sleeping apps → add Sarthi Rakshak.',
  'oppo': 'Settings → Battery → More settings → Optimise battery use → Sarthi Rakshak → Don’t optimise. Allow Auto launch.',
  'realme': 'Settings → Battery → App battery management → Sarthi Rakshak → Allow background activity and Auto launch.',
  'vivo': 'Settings → Battery → Background power consumption → Sarthi Rakshak → Allow. Turn on Autostart in i Manager.',
  'oneplus': 'Settings → Battery → Battery optimisation → Sarthi Rakshak → Don’t optimise.',
  'motorola': 'Settings → Apps → Sarthi Rakshak → Battery → Unrestricted.',
  'google': 'Settings → Apps → Sarthi Rakshak → Battery → Unrestricted.',
};

/// Safety setup (setup step 2 of 2 and Settings → Safety setup): permissions, battery, test SOS.
class SafetySetupScreen extends StatefulWidget {
  const SafetySetupScreen({super.key, this.setupStep = false});
  final bool setupStep;

  @override
  State<SafetySetupScreen> createState() => _SafetySetupScreenState();
}

class _SafetySetupScreenState extends State<SafetySetupScreen> with WidgetsBindingObserver {
  bool _location = false;
  bool _locationAlways = false;
  bool _notifications = false;
  bool _sms = false;
  bool _microphone = false;
  bool _battery = false;
  String _brand = '';

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _check();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState s) {
    // Back from the phone's settings: check again.
    if (s == AppLifecycleState.resumed) _check();
  }

  Future<void> _check() async {
    final engine = AppScope.read(context).engine;
    final info = await engine.deviceInfo();
    final results = await Future.wait([
      Permission.location.isGranted,
      Permission.locationAlways.isGranted,
      Permission.notification.isGranted,
      Permission.sms.isGranted,
      Permission.microphone.isGranted,
      engine.batteryOptimisationOff(),
    ]);
    if (!mounted) return;
    setState(() {
      _location = results[0];
      _locationAlways = results[1];
      _notifications = results[2];
      _sms = results[3];
      _microphone = results[4];
      _battery = results[5];
      _brand = ((info['manufacturer'] as String?) ?? '').toLowerCase();
    });
    AppScope.read(context).registerDevice();
  }

  Future<void> _ask(Permission p) async {
    final status = await p.request();
    if (status.isPermanentlyDenied) await openAppSettings();
    await _check();
  }

  Future<void> _testSos() async {
    final state = AppScope.read(context);
    if (!await confirm(context, 'Send a test SOS?',
        'Your guardians who accepted get an SMS marked TEST. No action needed from them. (5 a day)', yes: 'Send test')) {
      return;
    }
    try {
      await state.api.testSos(state.newId());
      if (mounted) showInfo(context, 'Test sent. Ask a guardian if they got it.');
    } catch (e) {
      if (mounted) showError(context, e);
    }
  }

  @override
  Widget build(BuildContext context) {
    final state = AppScope.of(context);
    final accepted = state.guardians.where((g) => g.status == 'accepted').length;
    final protected = _location && _locationAlways && _notifications && _microphone && _battery && accepted > 0;
    final guide = batteryGuides.entries.where((e) => _brand.contains(e.key)).map((e) => e.value).firstOrNull ??
        'Settings → Apps → Sarthi Rakshak → Battery → Unrestricted (or “Don’t optimise”).';

    return Scaffold(
      appBar: AppBar(title: Text(widget.setupStep ? 'Step 2 of 2' : 'Safety setup')),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(20, 4, 20, 24),
        children: [
          const ScreenTitle('Keep protection on.', subtitle: 'These let SOS work even with the screen off or no internet.'),
          const SizedBox(height: 16),
          AppCard(
            color: protected ? AppColors.greenSoft : AppColors.amberSoft,
            child: Row(children: [
              Icon(protected ? Icons.verified_user : Icons.warning_amber_rounded,
                  color: protected ? AppColors.green : AppColors.amber, size: 30),
              const SizedBox(width: 12),
              Expanded(
                child: Text(protected ? 'You are protected' : 'A few steps left',
                    style: TextStyle(fontSize: 17, fontWeight: FontWeight.w700, color: protected ? AppColors.green : AppColors.amber)),
              ),
            ]),
          ),
          const SizedBox(height: 12),
          _Check(
            icon: Icons.location_on_outlined,
            title: 'Location',
            text: 'So guardians can find you during an SOS or journey.',
            ok: _location,
            onFix: () => _ask(Permission.location),
          ),
          _Check(
            icon: Icons.my_location,
            title: 'Location all the time',
            text: _location
                ? 'Keeps sharing when the screen is off. Choose “Allow all the time”.'
                : 'Allow “Location” above first. Then choose “Allow all the time” here.',
            ok: _locationAlways,
            onFix: _location ? () => _ask(Permission.locationAlways) : null,
          ),
          _Check(
            icon: Icons.notifications_none,
            title: 'Notifications',
            text: 'For check-ins and when a guardian responds.',
            ok: _notifications,
            onFix: () => _ask(Permission.notification),
          ),
          _Check(
            icon: Icons.mic_none,
            title: 'Microphone',
            text: 'Records audio during an SOS. Only you can listen.',
            ok: _microphone,
            onFix: () => _ask(Permission.microphone),
          ),
          _Check(
            icon: Icons.sms_outlined,
            title: 'SMS (recommended)',
            text: 'Sends your SOS from your own SIM when there is no internet. Without it, your SMS app opens ready to send.',
            ok: _sms,
            onFix: () => _ask(Permission.sms),
          ),
          _Check(
            icon: Icons.battery_saver_outlined,
            title: 'Battery saving off for this app',
            text: guide,
            ok: _battery,
            onFix: () async {
              await state.engine.askBatteryOptimisationOff();
              await _check();
            },
          ),
          _Check(
            icon: Icons.group_outlined,
            title: 'At least one guardian accepted',
            text: accepted > 0 ? '$accepted accepted' : 'Ask your guardians to open the invite SMS and tap Accept.',
            ok: accepted > 0,
            onFix: null,
          ),
          const SizedBox(height: 12),
          OutlinedButton.icon(
            onPressed: accepted == 0 ? null : _testSos,
            icon: const Icon(Icons.campaign_outlined),
            label: const Text('Send a test SOS'),
          ),
          const SizedBox(height: 12),
          if (widget.setupStep)
            FilledButton(onPressed: () => state.setupDone(), child: Text(protected ? 'Finish' : 'Finish later')),
        ],
      ),
    );
  }
}

class _Check extends StatelessWidget {
  const _Check({required this.icon, required this.title, required this.text, required this.ok, required this.onFix});
  final IconData icon;
  final String title;
  final String text;
  final bool ok;
  final VoidCallback? onFix;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(bottom: 10),
        child: AppCard(
          child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            CircleAvatar(
              radius: 20,
              backgroundColor: ok ? AppColors.greenSoft : AppColors.redSoft,
              child: Icon(ok ? Icons.check : icon, color: ok ? AppColors.green : AppColors.red, size: 22),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(title, style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 16)),
                const SizedBox(height: 2),
                Text(text, style: const TextStyle(color: AppColors.muted, height: 1.35)),
              ]),
            ),
            if (!ok && onFix != null)
              TextButton(
                style: TextButton.styleFrom(foregroundColor: AppColors.red),
                onPressed: onFix,
                child: const Text('Allow'),
              ),
          ]),
        ),
      );
}
