import 'package:flutter/material.dart';

import '../../api/models.dart';
import '../../theme.dart';

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
            const CircleAvatar(radius: 40, backgroundColor: AppColors.green, child: Icon(Icons.check, color: Colors.white, size: 46)),
            const SizedBox(height: 18),
            const Text('Journey Completed!', style: TextStyle(fontSize: 28, fontWeight: FontWeight.w800)),
            const SizedBox(height: 6),
            Text('You reached ${journey.destination.label} safely.',
                textAlign: TextAlign.center, style: const TextStyle(fontSize: 16, color: AppColors.muted)),
            const SizedBox(height: 22),
            Row(mainAxisAlignment: MainAxisAlignment.center, children: [
              _Box(value: '$minutes min', label: 'Duration'),
              const SizedBox(width: 12),
              const _Box(value: 'Told', label: 'Guardians'),
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
  const _Box({required this.value, required this.label});
  final String value;
  final String label;

  @override
  Widget build(BuildContext context) => Container(
        width: 130,
        padding: const EdgeInsets.symmetric(vertical: 16),
        decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(14)),
        child: Column(children: [
          Text(value, style: const TextStyle(fontSize: 22, fontWeight: FontWeight.w800)),
          Text(label, style: const TextStyle(color: AppColors.muted)),
        ]),
      );
}
