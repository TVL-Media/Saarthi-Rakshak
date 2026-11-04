import 'package:flutter/material.dart';

import '../../api/models.dart';
import '../../theme.dart';
import '../../widgets/common.dart';

/// "Journey Completed!" (design frame 12, without the safety score).
class JourneyCompleteScreen extends StatelessWidget {
  const JourneyCompleteScreen({super.key, required this.journey});
  final Journey journey;

  @override
  Widget build(BuildContext context) {
    final minutes = (journey.endedAt ?? DateTime.now()).difference(journey.startedAt).inMinutes;
    return Scaffold(
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(children: [
            const Spacer(),
            Container(
              padding: const EdgeInsets.all(12),
              decoration: const BoxDecoration(color: AppColors.greenSoft, shape: BoxShape.circle),
              child: const CircleAvatar(
                  radius: 40, backgroundColor: AppColors.green, child: Icon(Icons.check, color: Colors.white, size: 46)),
            ),
            const SizedBox(height: 18),
            const Text('Journey Completed!', style: TextStyle(fontSize: 28, fontWeight: FontWeight.w800)),
            const SizedBox(height: 6),
            Text('You reached ${journey.destination.label} safely.',
                textAlign: TextAlign.center, style: const TextStyle(fontSize: 16, color: AppColors.muted)),
            const SizedBox(height: 22),
            Row(children: [
              Expanded(child: _Box(icon: Icons.timer_outlined, value: '$minutes min', label: 'Duration')),
              const SizedBox(width: 12),
              const Expanded(child: _Box(icon: Icons.people_outline, value: 'Told', label: 'Guardians')),
            ]),
            const Spacer(),
            FilledButton(onPressed: () => Navigator.of(context).popUntil((r) => r.isFirst), child: const Text('Back to Home')),
          ]),
        ),
      ),
    );
  }
}

class _Box extends StatelessWidget {
  const _Box({required this.icon, required this.value, required this.label});
  final IconData icon;
  final String value;
  final String label;

  @override
  Widget build(BuildContext context) => AppCard(
        padding: const EdgeInsets.symmetric(vertical: 18, horizontal: 12),
        child: Column(children: [
          IconTile(icon, color: AppColors.green, background: AppColors.greenSoft, size: 40),
          const SizedBox(height: 10),
          Text(value, style: const TextStyle(fontSize: 22, fontWeight: FontWeight.w800)),
          const SizedBox(height: 2),
          Text(label, style: const TextStyle(color: AppColors.muted)),
        ]),
      );
}
