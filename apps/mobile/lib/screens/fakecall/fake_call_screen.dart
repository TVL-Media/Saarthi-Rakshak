import 'dart:async';

import 'package:flutter/material.dart';

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
          const SizedBox(height: 18),
          Container(
            padding: const EdgeInsets.all(20),
            decoration: BoxDecoration(color: AppColors.night, borderRadius: BorderRadius.circular(20)),
            child: Column(children: [
              Initials(_caller.text, size: 72),
              const SizedBox(height: 10),
              const Text('Incoming Call', style: TextStyle(color: Colors.white70)),
              Text(_caller.text.isEmpty ? 'Mom' : _caller.text,
                  style: const TextStyle(color: Colors.white, fontSize: 26, fontWeight: FontWeight.w700)),
              const Text('Mobile', style: TextStyle(color: Colors.white60)),
            ]),
          ),
          const SizedBox(height: 16),
          TextField(
            controller: _caller,
            onChanged: (_) => setState(() {}),
            textCapitalization: TextCapitalization.words,
            decoration: const InputDecoration(prefixIcon: Icon(Icons.person_outline), hintText: 'Caller name'),
          ),
          const SizedBox(height: 12),
          AppCard(
            child: Row(children: [
              const Icon(Icons.alarm),
              const SizedBox(width: 12),
              const Expanded(child: Text('Call delay', style: TextStyle(fontWeight: FontWeight.w600))),
              DropdownButton<int>(
                value: _delay,
                underline: const SizedBox.shrink(),
                items: const [
                  DropdownMenuItem(value: 0, child: Text('Now')),
                  DropdownMenuItem(value: 5, child: Text('5 seconds')),
                  DropdownMenuItem(value: 30, child: Text('30 seconds')),
                  DropdownMenuItem(value: 60, child: Text('1 minute')),
                ],
                onChanged: (v) => setState(() => _delay = v ?? 5),
              ),
            ]),
          ),
          const SizedBox(height: 20),
          FilledButton(onPressed: _start, child: const Text('Start Fake Call')),
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

  @override
  void initState() {
    super.initState();
    AppScope.read(context).engine.startRingtone().catchError((_) {});
  }

  @override
  void dispose() {
    _timer?.cancel();
    AppScope.read(context).engine.stopRingtone().catchError((_) {});
    super.dispose();
  }

  void _answer() {
    AppScope.read(context).engine.stopRingtone().catchError((_) {});
    setState(() => _answered = true);
    _timer = Timer.periodic(const Duration(seconds: 1), (_) => setState(() => _seconds++));
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
                _CallButton(color: AppColors.red, icon: Icons.call_end, label: _answered ? 'End' : 'Decline', onTap: () => Navigator.pop(context)),
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
