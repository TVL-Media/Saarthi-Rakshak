import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../state/app_state.dart';
import '../../theme.dart';
import 'sos_active_screen.dart';

/// "Emergency Activating" countdown (design: Emergency SOS). Cancel needs no PIN and nothing is
/// sent; the cancel is reported later as a false alarm. At 0 (or "Send SOS Now") the phone acts.
class SosCountdownScreen extends StatefulWidget {
  const SosCountdownScreen({super.key, required this.trigger, this.journeyId});

  /// button, widget, tile, checkin or journey.
  final String trigger;
  final String? journeyId;

  @override
  State<SosCountdownScreen> createState() => _SosCountdownScreenState();
}

class _SosCountdownScreenState extends State<SosCountdownScreen> {
  late final int _total;
  late int _left;
  Timer? _timer;
  late final String _sosId;
  final DateTime _startedAt = DateTime.now();
  bool _done = false;

  @override
  void initState() {
    super.initState();
    final state = AppScope.read(context);
    _sosId = state.newId();
    _total = state.me?.rule('sos.countdown_seconds', 5) ?? 5;
    _left = _total;
    HapticFeedback.heavyImpact();
    _timer = Timer.periodic(const Duration(seconds: 1), (_) {
      HapticFeedback.mediumImpact();
      setState(() => _left--);
      if (_left <= 0) _send();
    });
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  Future<void> _send() async {
    if (_done) return;
    _done = true;
    _timer?.cancel();
    final state = AppScope.read(context);
    await state.engine.startSos(
      sosId: _sosId,
      trigger: widget.trigger,
      journeyId: widget.journeyId,
      noInternetSmsAfterSeconds: 10,
    );
    if (!mounted) return;
    Navigator.of(context).pushReplacement(MaterialPageRoute(builder: (_) => SosActiveScreen(sosId: _sosId)));
  }

  void _cancel() {
    if (_done) return;
    _done = true;
    _timer?.cancel();
    // Saved as a false alarm (History, Reports). Nothing is sent to anyone.
    final api = AppScope.read(context).api;
    unawaited(api.reportCancelledSos(_sosId, widget.trigger, _startedAt).catchError((_) {}));
    Navigator.of(context).pop();
  }

  @override
  Widget build(BuildContext context) {
    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop) _cancel();
      },
      child: Scaffold(
        backgroundColor: const Color(0xFF3A0204),
        body: Container(
          decoration: const BoxDecoration(
            gradient: RadialGradient(
              center: Alignment(0, -0.2),
              radius: 1.1,
              colors: [Color(0xFFB0090F), Color(0xFF3A0204)],
            ),
          ),
          child: SafeArea(
            child: Padding(
              padding: const EdgeInsets.fromLTRB(20, 8, 20, 24),
              child: Column(children: [
                Align(
                  alignment: Alignment.centerLeft,
                  child: IconButton(onPressed: _cancel, icon: const Icon(Icons.chevron_left, color: Colors.white, size: 30)),
                ),
                const Text('Emergency Activating', style: TextStyle(color: Colors.white, fontSize: 24, fontWeight: FontWeight.w700)),
                const Spacer(),
                SizedBox(
                  width: 230,
                  height: 230,
                  child: Stack(alignment: Alignment.center, children: [
                    SizedBox.expand(
                      child: CircularProgressIndicator(
                        value: _left / _total,
                        strokeWidth: 14,
                        color: Colors.white,
                        backgroundColor: AppColors.red,
                      ),
                    ),
                    Column(mainAxisSize: MainAxisSize.min, children: [
                      Text('${_left.clamp(0, _total)}',
                          style: const TextStyle(color: Colors.white, fontSize: 88, fontWeight: FontWeight.w800, height: 1)),
                      const Text('seconds', style: TextStyle(color: Colors.white, fontSize: 18)),
                    ]),
                  ]),
                ),
                const SizedBox(height: 22),
                const Text('Your guardians will get your live location.',
                    textAlign: TextAlign.center, style: TextStyle(color: Colors.white70, fontSize: 15)),
                const Spacer(),
                FilledButton(
                  style: FilledButton.styleFrom(backgroundColor: Colors.white, foregroundColor: AppColors.ink),
                  onPressed: _cancel,
                  child: const Text('I’m Safe — cancel'),
                ),
                const SizedBox(height: 12),
                FilledButton(onPressed: _send, child: const Text('Send SOS Now')),
              ]),
            ),
          ),
        ),
      ),
    );
  }
}
