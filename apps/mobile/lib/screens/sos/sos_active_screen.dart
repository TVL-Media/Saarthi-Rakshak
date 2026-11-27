import 'dart:async';

import 'package:flutter/material.dart';
import 'package:permission_handler/permission_handler.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../api/api_client.dart';
import '../../api/models.dart';
import '../../engine/engine.dart';
import '../../state/app_state.dart';
import '../../theme.dart';
import '../phase4/services_screens.dart';
import '../../widgets/common.dart';
import '../../widgets/format.dart';
import 'recordings_screen.dart';
import 'sos_photos.dart';

/// SOS active (design: "Live Location Sharing"). Status comes from the engine (works offline) and,
/// when online, the guardians' status from the server.
class SosActiveScreen extends StatefulWidget {
  const SosActiveScreen({super.key, required this.sosId});
  final String sosId;

  @override
  State<SosActiveScreen> createState() => _SosActiveScreenState();
}

class _SosActiveScreenState extends State<SosActiveScreen> with WidgetsBindingObserver {
  Sos? _sos;
  Timer? _poll;
  Timer? _tick;
  final DateTime _openedAt = DateTime.now();

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _load();
    _poll = Timer.periodic(const Duration(seconds: 8), (_) => _load());
    // Every second: the recorded time counts up while recording.
    _tick = Timer.periodic(const Duration(seconds: 1), (_) => setState(() {}));
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _poll?.cancel();
    _tick?.cancel();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    // Back from the app's settings: start audio / location if they are allowed now.
    if (state == AppLifecycleState.resumed) AppScope.read(context).engine.resume().catchError((_) {});
  }

  Future<void> _load() async {
    try {
      final sos = await AppScope.read(context).api.sos(widget.sosId);
      if (!mounted) return;
      setState(() => _sos = sos);
      if (sos.status != 'active') _poll?.cancel();
    } on ApiException {
      // Not on the server yet (offline) — the engine keeps trying.
    }
  }

  Future<void> _safe() async {
    final ok = await confirm(context, 'Are you safe?', 'Your guardians will get “I am safe”, and sharing stops.', yes: 'I’m safe');
    if (!ok || !mounted) return;
    await AppScope.read(context).engine.endSos(widget.sosId);
    if (mounted) Navigator.of(context).popUntil((r) => r.isFirst);
  }

  @override
  Widget build(BuildContext context) {
    final state = AppScope.of(context);
    final engine = state.engineState;
    final sos = _sos;
    final guardians = state.guardians.where((g) => g.status != 'declined').toList();
    final startedAt = sos?.startedAt ?? _openedAt;
    final waitMinutes = state.me?.rule('sos.no_response_minutes', 5) ?? 5;
    final nobodyResponding = !(sos?.anyoneResponding ?? false);
    final call112Big = guardians.isEmpty || (nobodyResponding && DateTime.now().difference(startedAt).inMinutes >= waitMinutes);
    final ended = sos != null && sos.status != 'active' || (engine.sosId != widget.sosId && sos?.status == 'ended');

    return Scaffold(
      appBar: AppBar(
        title: const Text('SOS active'),
        leading: IconButton(icon: const Icon(Icons.chevron_left), onPressed: () => Navigator.of(context).popUntil((r) => r.isFirst)),
      ),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(20, 4, 20, 24),
        children: [
          Container(
            padding: const EdgeInsets.all(18),
            decoration: BoxDecoration(color: ended ? AppColors.green : AppColors.red, borderRadius: BorderRadius.circular(20)),
            child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
              IconTile(ended ? Icons.verified_user_outlined : Icons.sos,
                  color: Colors.white, background: Colors.white.withValues(alpha: 0.18), size: 48),
              const SizedBox(width: 14),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text(ended ? 'SOS ended' : 'Help is on the way',
                      style: const TextStyle(color: Colors.white, fontSize: 23, fontWeight: FontWeight.w800)),
                  const SizedBox(height: 4),
                  Text(
                    ended
                        ? 'Your guardians were told you are safe.'
                        : 'Started at ${clock(startedAt)}. Your guardians can see where you are.',
                    style: const TextStyle(color: Colors.white, fontSize: 15, height: 1.35),
                  ),
                ]),
              ),
            ]),
          ),
          const SizedBox(height: 14),
          if (!ended)
            _Group(children: [
            _Status(
              icon: engine.locationOff ? Icons.location_off : Icons.radio_button_checked,
              ok: !engine.locationOff,
              text: engine.locationOff
                  ? 'Location is off — turn it on so guardians can find you'
                  : engine.lastFixAt == null
                      ? 'Finding your location…'
                      : 'Sharing live location · updated ${ago(engine.lastFixAt!)}',
            ),
            _AudioStatus(engine: engine, onListen: () => Navigator.push(context, MaterialPageRoute(builder: (_) => RecordingsScreen(sosId: widget.sosId)))),
            if (engine.batteryPct != null)
              _Status(icon: Icons.battery_std, ok: engine.batteryPct! > 15, text: 'Battery ${engine.batteryPct}%'),
            if (!engine.online || !engine.sosSentToServer)
              _Status(
                icon: Icons.sms_outlined,
                ok: engine.simSmsSentTo.isNotEmpty,
                text: engine.simSmsSentTo.isNotEmpty
                    ? 'No internet — SOS sent by SMS from your phone. Retrying the server…'
                    : 'Connecting… If there is no internet, your SOS goes out by SMS.',
              ),
          ]),
          if (!ended)
            Align(
              alignment: Alignment.centerLeft,
              child: TextButton.icon(
                key: const Key('app-permissions'),
                onPressed: openAppSettings,
                icon: const Icon(Icons.settings_outlined, color: AppColors.red),
                label: const Text('App permissions (microphone, location)', style: TextStyle(color: AppColors.red)),
              ),
            ),
          const SizedBox(height: 10),
          if (!ended)
            FilledButton.icon(
              style: FilledButton.styleFrom(
                backgroundColor: call112Big ? AppColors.red : Colors.white,
                foregroundColor: call112Big ? Colors.white : AppColors.red,
                minimumSize: Size.fromHeight(call112Big ? 72 : 54),
                side: const BorderSide(color: AppColors.red),
                textStyle: TextStyle(fontSize: call112Big ? 22 : 17, fontWeight: FontWeight.w800),
              ),
              onPressed: () => launchUrl(Uri.parse('tel:112')),
              icon: const Icon(Icons.local_phone),
              label: const Text('Call 112'),
            ),
          if (!ended && AppScope.read(context).feature4('police_handoff')) HandoffStatus(sosId: widget.sosId),
          if (guardians.isEmpty && !ended)
            const Padding(
              padding: EdgeInsets.only(top: 10),
              child: Text('No guardian to alert. Call 112 if you need help.', style: TextStyle(color: AppColors.red, fontWeight: FontWeight.w600)),
            ),
          const SizedBox(height: 18),
          const SectionLabel('Guardians'),
          if (sos != null && sos.guardians.isNotEmpty || sos == null && guardians.isNotEmpty)
            _Group(children: [
              if (sos != null)
                for (final g in sos.guardians) _GuardianRow(name: g.name, status: g.statusText, responding: g.respondingAt != null)
              else
                for (final g in guardians)
                  _GuardianRow(name: g.name, status: engine.simSmsSentTo.contains(g.id) ? 'Sent by SMS' : 'Sending…', responding: false),
            ]),
          const SizedBox(height: 10),
          SosPhotos(sosId: widget.sosId, active: !ended),
          if (ended && state.feature('vault'))
            OutlinedButton.icon(
              key: const Key('sos-to-vault'),
              onPressed: () => saveSosToVault(context, widget.sosId, startedAt),
              icon: const Icon(Icons.lock_outline),
              label: const Text('Save photos and recording to Mere Saboot'),
            ),
          const SizedBox(height: 24),
          if (!ended) FilledButton(style: FilledButton.styleFrom(backgroundColor: AppColors.green), onPressed: _safe, child: const Text('I’m safe'))
          else FilledButton(onPressed: () => Navigator.of(context).popUntil((r) => r.isFirst), child: const Text('Back to Home')),
        ],
      ),
    );
  }
}

/// One white card with rows separated by thin lines.
class _Group extends StatelessWidget {
  const _Group({required this.children});
  final List<Widget> children;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(bottom: 8),
        child: AppCard(
          padding: EdgeInsets.zero,
          child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            for (var i = 0; i < children.length; i++) ...[
              if (i > 0) const Divider(height: 1, thickness: 1, indent: 64, color: Color(0xFFF0ECE7)),
              children[i],
            ],
          ]),
        ),
      );
}

class _Status extends StatelessWidget {
  const _Status({required this.icon, required this.ok, required this.text});
  final IconData icon;
  final bool ok;
  final String text;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
        child: Row(children: [
          IconTile(icon, color: ok ? AppColors.red : AppColors.amber, size: 36),
          const SizedBox(width: 14),
          Expanded(child: Text(text, style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w500, height: 1.3))),
        ]),
      );
}

/// Audio: a red dot that pulses while recording, the time recorded so far and the saved clips.
class _AudioStatus extends StatelessWidget {
  const _AudioStatus({required this.engine, required this.onListen});
  final EngineState engine;
  final VoidCallback onListen;

  @override
  Widget build(BuildContext context) {
    final recorded = engine.audioRecorded(DateTime.now());
    final mm = recorded.inMinutes.toString().padLeft(2, '0');
    final ss = (recorded.inSeconds % 60).toString().padLeft(2, '0');
    final String title;
    final String? detail;
    if (engine.audioOff) {
      title = 'Audio off';
      detail = 'Allow the microphone in App permissions below';
    } else if (engine.recording) {
      title = 'Recording audio · $mm:$ss';
      detail = engine.audioClips == 0
          ? 'First clip is saved after 30 seconds'
          : '${engine.audioClips} clip${engine.audioClips == 1 ? '' : 's'} saved on this phone';
    } else if (engine.audioError != null) {
      title = 'Audio could not start';
      detail = '${engine.audioError}. Trying again…';
    } else {
      title = 'Starting audio…';
      detail = null;
    }
    return Padding(
      padding: const EdgeInsets.fromLTRB(14, 12, 8, 12),
      child: Row(children: [
        engine.recording
            ? Container(
                width: 36,
                height: 36,
                decoration: BoxDecoration(color: AppColors.redSoft, borderRadius: BorderRadius.circular(11)),
                child: const _RecordingDot(),
              )
            : IconTile(engine.audioOff || engine.audioError != null ? Icons.mic_off : Icons.mic, color: AppColors.amber, size: 36),
        const SizedBox(width: 14),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(title, key: const Key('audio-title'), style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600)),
            if (detail != null) ...[
              const SizedBox(height: 2),
              Text(detail, style: const TextStyle(color: AppColors.muted, fontSize: 13.5)),
            ],
          ]),
        ),
        if (engine.audioClips > 0)
          TextButton.icon(
            key: const Key('listen'),
            style: TextButton.styleFrom(padding: const EdgeInsets.symmetric(horizontal: 10)),
            onPressed: onListen,
            icon: const Icon(Icons.headphones, color: AppColors.red, size: 20),
            label: const Text('Listen', style: TextStyle(color: AppColors.red, fontWeight: FontWeight.w700)),
          ),
      ]),
    );
  }
}

class _RecordingDot extends StatefulWidget {
  const _RecordingDot();

  @override
  State<_RecordingDot> createState() => _RecordingDotState();
}

class _RecordingDotState extends State<_RecordingDot> with SingleTickerProviderStateMixin {
  late final AnimationController _pulse = AnimationController(vsync: this, duration: const Duration(milliseconds: 900))
    ..repeat(reverse: true);

  @override
  void dispose() {
    _pulse.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => SizedBox(
        width: 24,
        height: 24,
        child: Center(
          child: FadeTransition(
            opacity: Tween<double>(begin: 0.35, end: 1).animate(_pulse),
            child: Container(
              key: const Key('recording-dot'),
              width: 16,
              height: 16,
              decoration: const BoxDecoration(color: AppColors.red, shape: BoxShape.circle),
            ),
          ),
        ),
      );
}

class _GuardianRow extends StatelessWidget {
  const _GuardianRow({required this.name, required this.status, required this.responding});
  final String name;
  final String status;
  final bool responding;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.fromLTRB(14, 10, 14, 10),
        child: Row(children: [
          Initials(name, size: 40),
          const SizedBox(width: 14),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(name,
                  maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 16)),
              const SizedBox(height: 4),
              StatusPill(status, color: responding ? AppColors.green : AppColors.muted),
            ]),
          ),
        ]),
      );
}
