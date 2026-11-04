import 'dart:async';

import 'package:flutter/material.dart';

import '../../engine/engine.dart';
import '../../state/app_state.dart';
import '../../theme.dart';
import '../../widgets/common.dart';

/// Fake call (design frame 17). Runs only on the phone: nothing is sent or logged.
class FakeCallScreen extends StatefulWidget {
  const FakeCallScreen({super.key});

  @override
  State<FakeCallScreen> createState() => _FakeCallScreenState();
}

class _FakeCallScreenState extends State<FakeCallScreen> {
  final _caller = TextEditingController(text: 'Mom');
  int _delay = 5;
  Timer? _timer;

  @override
  void dispose() {
    _timer?.cancel();
    _caller.dispose();
    super.dispose();
  }

  void _start() {
    final name = _caller.text.trim().isEmpty ? 'Mom' : _caller.text.trim();
    showInfo(context, _delay == 0 ? 'Calling…' : 'Your phone will ring in $_delay seconds.');
    _timer?.cancel();
    _timer = Timer(Duration(seconds: _delay), () {
      if (!mounted) return;
      Navigator.of(context, rootNavigator: true).push(MaterialPageRoute(fullscreenDialog: true, builder: (_) => IncomingCallScreen(caller: name)));
    });
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(20, 0, 20, 24),
        children: [
          const ScreenTitle('Fake Call', subtitle: 'Exit uncomfortable situations with a realistic incoming call.'),
          const SizedBox(height: 20),
          Container(
            padding: const EdgeInsets.fromLTRB(20, 24, 20, 22),
            decoration: BoxDecoration(
              color: AppColors.night,
              borderRadius: BorderRadius.circular(22),
            ),
            child: Column(children: [
              Initials(_caller.text, size: 76),
              const SizedBox(height: 12),
              const Text('Incoming Call', style: TextStyle(color: Colors.white70, fontSize: 14)),
              const SizedBox(height: 2),
              Text(_caller.text.isEmpty ? 'Mom' : _caller.text,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(color: Colors.white, fontSize: 26, fontWeight: FontWeight.w700)),
              const Text('Mobile', style: TextStyle(color: Colors.white60)),
              const SizedBox(height: 18),
              const Row(mainAxisAlignment: MainAxisAlignment.spaceEvenly, children: [
                CircleAvatar(radius: 20, backgroundColor: AppColors.red, child: Icon(Icons.call_end, color: Colors.white, size: 20)),
                CircleAvatar(radius: 20, backgroundColor: Color(0xFF22C55E), child: Icon(Icons.call, color: Colors.white, size: 20)),
              ]),
            ]),
          ),
          const SizedBox(height: 24),
          const SectionLabel('Caller name'),
          TextField(
            controller: _caller,
            onChanged: (_) => setState(() {}),
            textCapitalization: TextCapitalization.words,
            decoration: const InputDecoration(prefixIcon: Icon(Icons.person_outline), hintText: 'Caller name'),
          ),
          const SizedBox(height: 20),
          const SectionLabel('Call delay'),
          Row(children: [
            for (final (n, (value, label)) in const [(0, 'Now'), (5, '5 sec'), (30, '30 sec'), (60, '1 min')].indexed) ...[
              if (n > 0) const SizedBox(width: 8),
              Expanded(
                child: Material(
                  color: _delay == value ? AppColors.red : Colors.white,
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(12),
                    side: BorderSide(color: _delay == value ? AppColors.red : AppColors.line),
                  ),
                  child: InkWell(
                    key: Key('delay-$value'),
                    borderRadius: BorderRadius.circular(12),
                    onTap: () => setState(() => _delay = value),
                    child: SizedBox(
                      height: 48,
                      child: Center(
                        child: Text(label,
                            style: TextStyle(
                              fontWeight: FontWeight.w600,
                              color: _delay == value ? Colors.white : AppColors.ink,
                            )),
                      ),
                    ),
                  ),
                ),
              ),
            ],
          ]),
          const SizedBox(height: 28),
          FilledButton.icon(onPressed: _start, icon: const Icon(Icons.phone_in_talk_outlined), label: const Text('Start Fake Call')),
        ],
      ),
    );
  }
}

/// Full-screen ringing call; Answer shows a call in progress.
class IncomingCallScreen extends StatefulWidget {
  const IncomingCallScreen({super.key, required this.caller});
  final String caller;

  @override
  State<IncomingCallScreen> createState() => _IncomingCallScreenState();
}

class _IncomingCallScreenState extends State<IncomingCallScreen> {
  bool _answered = false;
  int _seconds = 0;
  Timer? _timer;

  /// Kept from the start: while the screen closes it can no longer look the engine up, and the
  /// ringtone must always stop (Decline, End, Back or swipe).
  late final SafetyEngine _engine = AppScope.read(context).engine;

  @override
  void initState() {
    super.initState();
    _engine.startRingtone().catchError((_) {});
  }

  @override
  void dispose() {
    _timer?.cancel();
    _engine.stopRingtone().catchError((_) {});
    super.dispose();
  }

  void _answer() {
    _engine.stopRingtone().catchError((_) {});
    setState(() => _answered = true);
    _timer = Timer.periodic(const Duration(seconds: 1), (_) => setState(() => _seconds++));
  }

  void _hangUp() {
    _timer?.cancel();
    _engine.stopRingtone().catchError((_) {});
    Navigator.pop(context);
  }

  @override
  Widget build(BuildContext context) {
    final time = '${(_seconds ~/ 60).toString().padLeft(2, '0')}:${(_seconds % 60).toString().padLeft(2, '0')}';
    return Scaffold(
      backgroundColor: const Color(0xFF0E1116),
      body: SafeArea(
        child: Column(children: [
          const SizedBox(height: 60),
          Initials(widget.caller, size: 110),
          const SizedBox(height: 18),
          Text(widget.caller, style: const TextStyle(color: Colors.white, fontSize: 34, fontWeight: FontWeight.w600)),
          const SizedBox(height: 6),
          Text(_answered ? time : 'Mobile · Incoming call', style: const TextStyle(color: Colors.white70, fontSize: 17)),
          const Spacer(),
          Padding(
            padding: const EdgeInsets.fromLTRB(48, 0, 48, 48),
            child: Row(
              mainAxisAlignment: _answered ? MainAxisAlignment.center : MainAxisAlignment.spaceBetween,
              children: [
                _CallButton(color: AppColors.red, icon: Icons.call_end, label: _answered ? 'End' : 'Decline', onTap: _hangUp),
                if (!_answered) _CallButton(color: const Color(0xFF22C55E), icon: Icons.call, label: 'Answer', onTap: _answer),
              ],
            ),
          ),
        ]),
      ),
    );
  }
}

class _CallButton extends StatelessWidget {
  const _CallButton({required this.color, required this.icon, required this.label, required this.onTap});
  final Color color;
  final IconData icon;
  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => Column(children: [
        InkWell(
          onTap: onTap,
          customBorder: const CircleBorder(),
          child: CircleAvatar(radius: 36, backgroundColor: color, child: Icon(icon, color: Colors.white, size: 34)),
        ),
        const SizedBox(height: 8),
        Text(label, style: const TextStyle(color: Colors.white)),
      ]);
}
