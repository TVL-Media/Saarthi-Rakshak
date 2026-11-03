import 'package:flutter/material.dart';

import '../../config.dart';
import '../../state/app_state.dart';
import '../../theme.dart';

/// First launch only (design: SPLASH). The design's "24/7 Response" item is replaced by "Call 112":
/// Phase 1 must never be presented as 24/7 monitoring.
class WelcomeScreen extends StatelessWidget {
  const WelcomeScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.night,
      body: Container(
        decoration: const BoxDecoration(
          gradient: LinearGradient(
            begin: Alignment.topCenter,
            end: Alignment.bottomCenter,
            colors: [Color(0xFF1B1F27), Color(0xFF0B0D11), Color(0xFF2A0B0D)],
          ),
        ),
        child: SafeArea(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(24, 24, 24, 16),
            child: Column(
              children: [
                const Spacer(flex: 2),
                const _Logo(),
                const SizedBox(height: 18),
                const Text('हर सफर में, एक रक्षक', style: TextStyle(color: Colors.white, fontSize: 18)),
                const SizedBox(height: 6),
                const Text('In Every Journey, A Guardian', style: TextStyle(color: Colors.white70, fontSize: 15)),
                const Spacer(flex: 3),
                const Row(
                  mainAxisAlignment: MainAxisAlignment.spaceEvenly,
                  children: [
                    _Feature(icon: Icons.groups_outlined, text: 'Guardians\nalerted'),
                    _Feature(icon: Icons.location_on_outlined, text: 'Live\nlocation'),
                    _Feature(icon: Icons.local_phone_outlined, text: 'Call\n112'),
                  ],
                ),
                const SizedBox(height: 28),
                FilledButton(
                  onPressed: () => AppScope.read(context).markWelcomeSeen(),
                  child: const Row(mainAxisAlignment: MainAxisAlignment.center, children: [
                    Text('Get Started'),
                    SizedBox(width: 10),
                    Icon(Icons.arrow_forward, size: 20),
                  ]),
                ),
                const SizedBox(height: 14),
                const Text(
                  AppConfig.notMonitoring,
                  textAlign: TextAlign.center,
                  style: TextStyle(color: Colors.white60, fontSize: 12.5),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _Logo extends StatelessWidget {
  const _Logo();

  @override
  Widget build(BuildContext context) => const Column(children: [
        Icon(Icons.shield, color: AppColors.red, size: 84),
        SizedBox(height: 8),
        Text('SARTHI', style: TextStyle(color: Colors.white, fontSize: 40, fontWeight: FontWeight.w800, height: 1)),
        Text('RAKSHAK', style: TextStyle(color: AppColors.red, fontSize: 40, fontWeight: FontWeight.w800, height: 1.05)),
      ]);
}

class _Feature extends StatelessWidget {
  const _Feature({required this.icon, required this.text});
  final IconData icon;
  final String text;

  @override
  Widget build(BuildContext context) => Column(children: [
        Icon(icon, color: AppColors.red, size: 26),
        const SizedBox(height: 6),
        Text(text, textAlign: TextAlign.center, style: const TextStyle(color: Colors.white, fontSize: 13)),
      ]);
}
