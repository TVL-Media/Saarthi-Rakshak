import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import '../../api/api_client.dart';
import '../../theme.dart';
import '../../widgets/format.dart';

/// Shown when the server does not have a Phase 3 feature yet (never fake data).
class NotAvailableYet extends StatelessWidget {
  const NotAvailableYet({super.key, this.onRetry});
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) => Center(
        child: Padding(
          padding: const EdgeInsets.all(28),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            const Icon(Icons.hourglass_empty_rounded, size: 48, color: AppColors.muted),
            const SizedBox(height: 14),
            const Text('Not available yet',
                textAlign: TextAlign.center, style: TextStyle(fontSize: 19, fontWeight: FontWeight.w700)),
            const SizedBox(height: 8),
            const Text('This service is not switched on in your area yet. We will let you know when it is.',
                textAlign: TextAlign.center, style: TextStyle(color: AppColors.muted, fontSize: 15.5, height: 1.4)),
            if (onRetry != null) ...[
              const SizedBox(height: 18),
              OutlinedButton(onPressed: onRetry, child: const Text('Check again')),
            ],
          ]),
        ),
      );
}

/// A load that failed (offline, server busy): a message and a retry button.
class LoadFailed extends StatelessWidget {
  const LoadFailed({super.key, required this.error, required this.onRetry});
  final Object error;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) => Center(
        child: Padding(
          padding: const EdgeInsets.all(28),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            Text(error is ApiException ? (error as ApiException).message : 'Could not load. Please try again.',
                textAlign: TextAlign.center, style: const TextStyle(fontSize: 16)),
            const SizedBox(height: 14),
            OutlinedButton(onPressed: onRetry, child: const Text('Try again')),
          ]),
        ),
      );
}

String statusLabel(String status) => switch (status) {
      'requested' => 'Requested',
      'quoted' => 'Quote ready',
      'confirmed' => 'Confirmed',
      'assigned' => 'Rakshak assigned',
      'in_progress' => 'In progress',
      'completed' => 'Completed',
      'cancelled' => 'Cancelled',
      _ => status,
    };

Color statusColor(String status) => switch (status) {
      'quoted' => AppColors.amber,
      'confirmed' || 'assigned' || 'in_progress' => AppColors.green,
      'completed' => AppColors.muted,
      'cancelled' => AppColors.redDark,
      _ => AppColors.amber,
    };

final _rupees = NumberFormat.currency(locale: 'en_IN', symbol: '₹', decimalDigits: 0);
final _rupeesPaise = NumberFormat.currency(locale: 'en_IN', symbol: '₹', decimalDigits: 2);

/// 49900 -> "₹499", 49950 -> "₹499.50".
String money(int paise) => paise % 100 == 0 ? _rupees.format(paise / 100) : _rupeesPaise.format(paise / 100);

/// "21 Nov, 4:00 pm – 6:00 pm" (same day) or both dates when it crosses midnight.
String windowText(DateTime start, DateTime end) {
  final s = start.toLocal();
  final e = end.toLocal();
  final sameDay = s.year == e.year && s.month == e.month && s.day == e.day;
  final day = DateFormat('d MMM').format(s);
  return sameDay ? '$day, ${clock(s)} – ${clock(e)}' : '$day, ${clock(s)} – ${DateFormat('d MMM').format(e)}, ${clock(e)}';
}

String distanceText(int metres) => metres < 1000 ? '$metres m' : '${(metres / 1000).toStringAsFixed(1)} km';
