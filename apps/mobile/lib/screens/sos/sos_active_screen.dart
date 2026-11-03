import 'dart:async';

import 'package:flutter/material.dart';
import 'package:permission_handler/permission_handler.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../api/api_client.dart';
import '../../api/models.dart';
import '../../state/app_state.dart';
import '../../theme.dart';
import '../../widgets/common.dart';
import '../../widgets/format.dart';

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
    _tick = Timer.periodic(const Duration(seconds: 15), (_) => setState(() {}));
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
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(ended ? 'SOS ended' : 'Help is on the way',
                  style: const TextStyle(color: Colors.white, fontSize: 24, fontWeight: FontWeight.w800)),
              const SizedBox(height: 4),
              Text(
                ended
                    ? 'Your guardians were told you are safe.'
                    : 'Started at ${clock(startedAt)}. Your guardians can see where you are.',
                style: const TextStyle(color: Colors.white, fontSize: 15),
              ),
            ]),
          ),
          const SizedBox(height: 14),
          if (!ended) ...[
            _Status(
              icon: engine.locationOff ? Icons.location_off : Icons.radio_button_checked,
              ok: !engine.locationOff,
              text: engine.locationOff
                  ? 'Location is off — turn it on so guardians can find you'
                  : engine.lastFixAt == null
                      ? 'Finding your location…'
                      : 'Sharing live location · updated ${ago(engine.lastFixAt!)}',
            ),
            _Status(
              icon: engine.audioOff || engine.audioError != null ? Icons.mic_off : Icons.mic,
              ok: engine.recording,
              text: engine.audioOff
                  ? 'Audio off — allow the microphone in App permissions'
                  : engine.recording
                      ? 'Recording audio'
                      : engine.audioError != null
                          ? 'Audio could not start (${engine.audioError}). Trying again…'
                          : 'Starting audio…',
            ),
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
          ],
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
          if (guardians.isEmpty && !ended)
            const Padding(
              padding: EdgeInsets.only(top: 10),
              child: Text('No guardian to alert. Call 112 if you need help.', style: TextStyle(color: AppColors.red, fontWeight: FontWeight.w600)),
            ),
          const SizedBox(height: 18),
          const SectionLabel('Guardians'),
          if (sos != null)
            for (final g in sos.guardians) _GuardianRow(name: g.name, status: g.statusText, responding: g.respondingAt != null)
          else
            for (final g in guardians) _GuardianRow(name: g.name, status: engine.simSmsSentTo.contains(g.id) ? 'Sent by SMS' : 'Sending…', responding: false),
          const SizedBox(height: 24),
          if (!ended) FilledButton(style: FilledButton.styleFrom(backgroundColor: AppColors.green), onPressed: _safe, child: const Text('I’m safe'))
          else FilledButton(onPressed: () => Navigator.of(context).popUntil((r) => r.isFirst), child: const Text('Back to Home')),
        ],
      ),
    );
  }
}

class _Status extends StatelessWidget {
  const _Status({required this.icon, required this.ok, required this.text});
  final IconData icon;
  final bool ok;
  final String text;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(bottom: 8),
        child: AppCard(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
          child: Row(children: [
            Icon(icon, color: ok ? AppColors.red : AppColors.amber),
            const SizedBox(width: 12),
            Expanded(child: Text(text, style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w500))),
          ]),
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
        padding: const EdgeInsets.only(bottom: 8),
        child: AppCard(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
          child: Row(children: [
            Initials(name, size: 44),
            const SizedBox(width: 12),
            Expanded(child: Text(name, style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 16))),
            Text(status,
                style: TextStyle(color: responding ? AppColors.green : AppColors.muted, fontWeight: responding ? FontWeight.w700 : FontWeight.w500)),
          ]),
        ),
      );
}
