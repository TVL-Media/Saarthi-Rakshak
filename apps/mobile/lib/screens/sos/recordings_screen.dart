import 'dart:async';

import 'package:flutter/material.dart';

import '../../engine/engine.dart';
import '../../state/app_state.dart';
import '../../theme.dart';
import '../../widgets/common.dart';
import '../../widgets/format.dart';

/// SOS recordings kept on this phone (locked with a key that never leaves it). Only this phone can
/// play them; they are deleted after 30 days and when the user logs out.
class RecordingsScreen extends StatefulWidget {
  const RecordingsScreen({super.key, this.sosId});

  /// Only this SOS; null = all recordings on the phone.
  final String? sosId;

  @override
  State<RecordingsScreen> createState() => _RecordingsScreenState();
}

class _RecordingsScreenState extends State<RecordingsScreen> {
  List<LocalClip>? _clips;
  String? _playing;
  String? _error;
  Timer? _refresh;
  late final AppState _state = AppScope.read(context);

  @override
  void initState() {
    super.initState();
    _load();
    // New clips arrive every 30 seconds during an SOS.
    _refresh = Timer.periodic(const Duration(seconds: 10), (_) => _load());
    _state.playbackDone.addListener(_onDone);
  }

  @override
  void dispose() {
    _refresh?.cancel();
    _state.playbackDone.removeListener(_onDone);
    if (_playing != null) _state.engine.stopPlayback().catchError((_) {});
    super.dispose();
  }

  void _onDone() {
    if (mounted) setState(() => _playing = null);
  }

  Future<void> _load() async {
    try {
      final clips = await _state.engine.listClips(sosId: widget.sosId);
      if (mounted) setState(() => _clips = clips);
    } catch (_) {
      if (mounted) setState(() => _clips ??= const []);
    }
  }

  Future<void> _toggle(LocalClip c) async {
    final engine = _state.engine;
    setState(() => _error = null);
    try {
      if (_playing == c.id) {
        await engine.stopPlayback();
        setState(() => _playing = null);
        return;
      }
      await engine.playClip(c.id);
      setState(() => _playing = c.id);
    } catch (_) {
      setState(() {
        _playing = null;
        _error = 'This recording could not be played on this phone.';
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final clips = _clips;
    return Scaffold(
      appBar: AppBar(title: const Text('Recordings')),
      body: clips == null
          ? const Center(child: CircularProgressIndicator())
          : ListView(
              padding: const EdgeInsets.fromLTRB(20, 8, 20, 24),
              children: [
                const NoticeBox(
                  icon: Icons.lock_outline,
                  color: Color(0xFF4B5563),
                  background: Color(0xFFEFEBE6),
                  text: 'Recorded during your SOS, 30 seconds each. They are locked on this phone: only this phone can '
                      'play them, and they are deleted after 30 days or when you log out.',
                ),
                const SizedBox(height: 16),
                if (_error != null)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 10),
                    child: Text(
                      _error!,
                      style: const TextStyle(color: AppColors.red, fontWeight: FontWeight.w600),
                    ),
                  ),
                if (clips.isEmpty)
                  const EmptyState(icon: Icons.mic_none, text: 'No recordings on this phone yet')
                else
                  for (final c in clips)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 10),
                      child: AppCard(
                        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
                        child: Row(
                          children: [
                            IconButton(
                              key: Key('play-${c.id}'),
                              iconSize: 40,
                              icon: Icon(
                                _playing == c.id ? Icons.stop_circle : Icons.play_circle,
                                color: AppColors.red,
                              ),
                              onPressed: () => _toggle(c),
                            ),
                            const SizedBox(width: 4),
                            Expanded(
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Text(dateTime(c.recordedAt), style: const TextStyle(fontWeight: FontWeight.w700)),
                                  const SizedBox(height: 2),
                                  Text(
                                    '${c.seconds} s · ${c.uploaded ? 'Saved to your account' : 'On this phone only'}',
                                    style: const TextStyle(color: AppColors.muted),
                                  ),
                                ],
                              ),
                            ),
                            if (_playing == c.id)
                              const Padding(
                                padding: EdgeInsets.only(right: 8),
                                child: Text(
                                  'Playing',
                                  style: TextStyle(color: AppColors.red, fontWeight: FontWeight.w600),
                                ),
                              ),
                          ],
                        ),
                      ),
                    ),
              ],
            ),
    );
  }
}
