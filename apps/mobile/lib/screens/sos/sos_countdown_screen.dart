import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../api/phase2_api.dart';
import '../../engine/engine.dart';
import '../../state/app_state.dart';
import '../../theme.dart';
import 'sos_active_screen.dart';

/// "Emergency Activating" countdown (design: Emergency SOS). Cancel needs no PIN and nothing is
/// sent; the cancel is reported later as a false alarm. At 0 (or "Send SOS Now") the phone acts.
class SosCountdownScreen extends StatefulWidget {
  const SosCountdownScreen({super.key, required this.trigger, this.journeyId, this.quiet, this.seconds, this.heightM});

  /// button, widget, tile, checkin, journey; Phase 2: shake, voice, crash, fall, discreet.
  final String trigger;
  final String? journeyId;

  /// Discreet mode: vibration only, dim screen, no big red screen (alerts go out normally).
  /// null = the user's setting.
  final bool? quiet;

  /// Crash and fall: a longer, loud countdown (from Settings).
  final int? seconds;

  /// Fall detection: approximate fall height.
  final String? heightM;

  bool get detection => trigger == 'crash' || trigger == 'fall';

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
  late final bool _quiet;
  late final SafetyEngine _engine = AppScope.read(context).engine;

  @override
  void initState() {
    super.initState();
    final state = AppScope.read(context);
    _sosId = state.newId();
    _quiet = !widget.detection && (widget.quiet ?? state.triggers.quietCountdown);
    _total = widget.detection
        ? (widget.seconds ?? state.me?.rule('detection.countdown_seconds', 10) ?? 10)
        : state.me?.rule('sos.countdown_seconds', 5) ?? 5;
    _left = _total;
    // Crash and fall: a loud alarm, so a hurt user (or people nearby) notice it.
    if (widget.detection) _engine.startRingtone().catchError((_) {});
    // Strong vibration all through the countdown, so an SOS started by mistake is noticed
    // (short and soft in discreet mode).
    _buzz(_quiet ? 120 : 700);
    _timer = Timer.periodic(const Duration(seconds: 1), (_) {
      setState(() => _left--);
      if (_left <= 0) {
        _send();
      } else if (!_quiet) {
        _buzz(450);
      }
    });
  }

  @override
  void dispose() {
    _timer?.cancel();
    if (widget.detection) _engine.stopRingtone().catchError((_) {});
    super.dispose();
  }

  void _buzz(int ms) {
    if (!_quiet) HapticFeedback.heavyImpact();
    _engine.vibrate(ms).catchError((_) {});
  }

  Future<void> _send() async {
    if (_done) return;
    _done = true;
    _timer?.cancel();
    final state = AppScope.read(context);
    if (widget.detection) _engine.stopRingtone().catchError((_) {});
    _buzz(_quiet ? 200 : 1200); // SOS is being sent
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
    // Phase 2 triggers: also counted to tune the thresholds.
    if (const {'shake', 'voice', 'crash', 'fall', 'discreet'}.contains(widget.trigger)) {
      unawaited(api.falseAlarm(_sosId, widget.trigger).catchError((_) {}));
    }
    if (widget.detection) _engine.stopRingtone().catchError((_) {});
    Navigator.of(context).pop();
  }

  String get _source => switch (widget.trigger) {
        'shake' => 'Started by shaking the phone',
        'voice' => 'Started by your voice phrase',
        'crash' => 'Started by crash detection',
        'fall' => widget.heightM != null ? 'Started by fall detection (about ${widget.heightM} m)' : 'Started by fall detection',
        'discreet' => 'Started by Quick help',
        _ => '',
      };

  /// Discreet mode: a dim, plain screen. Same SOS; vibration only.
  Widget _quietScreen() => PopScope(
        canPop: false,
        onPopInvokedWithResult: (didPop, _) {
          if (!didPop) _cancel();
        },
        child: Scaffold(
          backgroundColor: const Color(0xFF15171A),
          body: SafeArea(
            child: Padding(
              padding: const EdgeInsets.fromLTRB(24, 24, 24, 24),
              child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                const Spacer(),
                Text('Sending in ${_left.clamp(0, _total)}',
                    textAlign: TextAlign.center, style: const TextStyle(color: Colors.white70, fontSize: 22, fontWeight: FontWeight.w600)),
                const SizedBox(height: 8),
                const Text('Your guardians will get your live location.',
                    textAlign: TextAlign.center, style: TextStyle(color: Colors.white38, fontSize: 14)),
                const Spacer(),
                OutlinedButton(
                  style: OutlinedButton.styleFrom(
                      backgroundColor: Colors.transparent, foregroundColor: Colors.white70, side: const BorderSide(color: Colors.white24)),
                  onPressed: _cancel,
                  child: const Text('Cancel'),
                ),
                const SizedBox(height: 12),
                TextButton(onPressed: _send, child: const Text('Send now', style: TextStyle(color: Colors.white54))),
              ]),
            ),
          ),
        ),
      );

  @override
  Widget build(BuildContext context) {
    if (_quiet) return _quietScreen();
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
                Text(
                    widget.trigger == 'crash'
                        ? 'Did you crash?'
                        : widget.trigger == 'fall'
                            ? 'Did you fall?'
                            : 'Emergency Activating',
                    style: const TextStyle(color: Colors.white, fontSize: 24, fontWeight: FontWeight.w700)),
                if (_source.isNotEmpty) ...[
                  const SizedBox(height: 6),
                  Text(_source, textAlign: TextAlign.center, style: const TextStyle(color: Colors.white70, fontSize: 14.5)),
                ],
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
                  key: const Key('cancel-sos'),
                  style: FilledButton.styleFrom(
                    backgroundColor: Colors.white,
                    foregroundColor: AppColors.ink,
                    minimumSize: Size.fromHeight(widget.detection ? 72 : 54),
                    textStyle: TextStyle(fontSize: widget.detection ? 22 : 17, fontWeight: FontWeight.w800),
                  ),
                  onPressed: _cancel,
                  child: Text(widget.detection ? 'I’m OK' : 'I’m Safe — cancel'),
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
