import 'dart:async';

import 'package:flutter/material.dart';

import '../../api/api_client.dart';
import '../../state/app_state.dart';
import '../../theme.dart';
import '../sos/sos_active_screen.dart';

const _reasonText = {
  'stopped': 'You haven’t moved for a few minutes.',
  'off_route': 'You seem to be off your route.',
  'late': 'You are later than planned.',
};

/// "Are you safe?" (design frame 11). Shown over any screen, with a loud alert from the engine.
/// No answer in time → the server tells your guardians (not a full SOS).
class CheckinScreen extends StatefulWidget {
  const CheckinScreen({
    super.key,
    required this.checkinId,
    required this.reason,
    required this.journeyId,
    this.preview = false,
  });
  final String? checkinId;
  final String reason;
  final String? journeyId;

  /// "Preview check-in": shows what it looks like; nothing is sent.
  final bool preview;

  @override
  State<CheckinScreen> createState() => _CheckinScreenState();
}

class _CheckinScreenState extends State<CheckinScreen> {
  late final int _total;
  late int _left;
  Timer? _timer;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    final minutes = AppScope.read(context).me?.rule('checkin.reply_wait_minutes', 2) ?? 2;
    _total = minutes * 60;
    _left = _total;
    _timer = Timer.periodic(const Duration(seconds: 1), (_) {
      if (_left > 0) setState(() => _left--);
    });
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  Future<void> _answer(String answer) async {
    final state = AppScope.read(context);
    final pause = state.me?.rule('checkin.traffic_pause_minutes', 10) ?? 10;
    setState(() => _busy = true);
    try {
      await state.engine.checkinAnswered(widget.reason, answer, pauseMinutes: pause);
      if (!widget.preview && widget.checkinId != null) {
        await state.api.answerCheckin(widget.checkinId!, answer);
      }
    } on ApiException catch (e) {
      // Offline: the engine keeps the answer locally; tell the user anyway.
      if (!e.isOffline && mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.message)));
    }
    if (!mounted) return;
    state.checkinAlert.value = null;
    if (answer == 'sos' && !widget.preview) {
      final sosId = state.newId();
      await state.engine.startSos(sosId: sosId, trigger: 'checkin', journeyId: widget.journeyId, noInternetSmsAfterSeconds: 10);
      if (!mounted) return;
      Navigator.of(context).pushReplacement(MaterialPageRoute(builder: (_) => SosActiveScreen(sosId: sosId)));
    } else {
      Navigator.of(context).pop();
    }
  }

  @override
  Widget build(BuildContext context) {
    final mm = (_left ~/ 60).toString();
    final ss = (_left % 60).toString().padLeft(2, '0');
    return PopScope(
      canPop: widget.preview,
      child: Scaffold(
        body: SafeArea(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(20, 24, 20, 20),
            child: Column(children: [
              if (widget.preview)
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
                  decoration: BoxDecoration(color: AppColors.amberSoft, borderRadius: BorderRadius.circular(20)),
                  child: const Text('PREVIEW — nothing is sent', style: TextStyle(color: AppColors.amber, fontWeight: FontWeight.w700)),
                ),
              const SizedBox(height: 12),
              const Text('Are you safe?', style: TextStyle(fontSize: 30, fontWeight: FontWeight.w800)),
              const SizedBox(height: 6),
              Text(_reasonText[widget.reason] ?? 'Please confirm your safety.',
                  textAlign: TextAlign.center, style: const TextStyle(fontSize: 16, color: AppColors.muted)),
              const Spacer(),
              SizedBox(
                width: 220,
                height: 220,
                child: Stack(alignment: Alignment.center, children: [
                  SizedBox.expand(
                    child: CircularProgressIndicator(
                      value: _left / _total,
                      strokeWidth: 16,
                      color: AppColors.red,
                      backgroundColor: AppColors.red.withValues(alpha: 0.25),
                    ),
                  ),
                  Column(mainAxisSize: MainAxisSize.min, children: [
                    Text('$mm:$ss', style: const TextStyle(fontSize: 54, fontWeight: FontWeight.w800)),
                    const Text('to answer', style: TextStyle(fontSize: 16, color: AppColors.muted)),
                  ]),
                ]),
              ),
              const Spacer(),
              FilledButton(
                style: FilledButton.styleFrom(backgroundColor: AppColors.green),
                onPressed: _busy ? null : () => _answer('fine'),
                child: const Text('I’m fine'),
              ),
              const SizedBox(height: 10),
              OutlinedButton(onPressed: _busy ? null : () => _answer('traffic_pause'), child: const Text('Stuck in traffic')),
              const SizedBox(height: 10),
              OutlinedButton(
                style: OutlinedButton.styleFrom(foregroundColor: AppColors.red, side: const BorderSide(color: AppColors.red)),
                onPressed: _busy ? null : () => _answer('sos'),
                child: const Text('I need help'),
              ),
              const SizedBox(height: 14),
              const Text('If you don’t answer, your guardians will be told.',
                  textAlign: TextAlign.center, style: TextStyle(color: AppColors.muted)),
            ]),
          ),
        ),
      ),
    );
  }
}
