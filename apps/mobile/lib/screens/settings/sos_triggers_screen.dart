import 'package:flutter/material.dart';
import 'package:permission_handler/permission_handler.dart';

import '../../api/api_client.dart';
import '../../state/app_state.dart';
import '../../theme.dart';
import '../../widgets/common.dart';

/// Settings → SOS triggers (features 1–5): shake, voice, drive mode, fall, discreet mode.
class SosTriggersScreen extends StatefulWidget {
  const SosTriggersScreen({super.key});

  @override
  State<SosTriggersScreen> createState() => _SosTriggersScreenState();
}

class _SosTriggersScreenState extends State<SosTriggersScreen> {
  late final AppState _state = AppScope.read(context);
  bool _saving = false;

  Future<void> _save(Map<String, Object?> change) async {
    setState(() => _saving = true);
    try {
      await _state.saveTriggers(change);
    } on ApiException catch (e) {
      if (mounted) showInfo(context, e.message);
    } catch (e) {
      if (mounted) showError(context, e);
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  Future<void> _practice() async {
    final g = ((_state.me?.rules['detection.shake_g_x10'] ?? 25) / 10).toDouble();
    showDialog<void>(
      context: context,
      barrierDismissible: false,
      builder: (_) => const AlertDialog(
        title: Text('Shake your phone now'),
        content: Text('Shake it hard 3 times. This is only practice: no SOS will be sent.'),
      ),
    );
    final ok = await _state.engine.practiceShake(g: g).catchError((_) => false);
    if (!mounted) return;
    Navigator.pop(context);
    showInfo(context, ok ? 'Shake felt. That is how hard to shake for an SOS.' : 'No shake felt. Shake harder, 3 times quickly.');
  }

  Future<bool> _betaOk(String title, String text) => confirm(context, title, text, yes: 'Turn on');

  @override
  Widget build(BuildContext context) {
    final state = AppScope.of(context);
    final t = state.triggers;
    final seconds = state.me?.rules['detection.countdown_seconds'] ?? 10;
    return Scaffold(
      appBar: AppBar(title: const Text('SOS triggers')),
      body: AbsorbPointer(
        absorbing: _saving,
        child: ListView(padding: const EdgeInsets.fromLTRB(20, 8, 20, 32), children: [
          const Text('More ways to start an SOS when you cannot reach the button. Every one starts a countdown first, so you can cancel a mistake.',
              style: TextStyle(color: AppColors.muted, fontSize: 15, height: 1.4)),
          const SizedBox(height: 16),
          if (state.feature('shake')) ...[
            const SectionLabel('Shake to SOS'),
            AppCard(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                const Row(children: [
                  IconTile(Icons.vibration, size: 40),
                  SizedBox(width: 14),
                  Expanded(child: Text('Shake the phone hard 3 times', style: TextStyle(fontSize: 16, fontWeight: FontWeight.w600))),
                ]),
                const SizedBox(height: 14),
                SizedBox(
                  width: double.infinity,
                  child: SegmentedButton<String>(
                    showSelectedIcon: false,
                    segments: const [
                      ButtonSegment(value: 'off', label: Text('Off')),
                      ButtonSegment(value: 'journey', label: Text('Journeys')),
                      ButtonSegment(value: 'always', label: Text('Always')),
                    ],
                    selected: {t.shakeMode},
                    onSelectionChanged: (v) => _save({'shakeMode': v.first}),
                  ),
                ),
                if (t.shakeMode == 'always')
                  const Padding(
                    padding: EdgeInsets.only(top: 12),
                    child: Text('A small notification stays on while shake is always on. It uses a little more battery.',
                        style: TextStyle(color: AppColors.muted, fontSize: 13.5, height: 1.35)),
                  ),
                const SizedBox(height: 8),
                TextButton.icon(onPressed: _practice, icon: const Icon(Icons.play_circle_outline), label: const Text('Try a practice shake')),
              ]),
            ),
            const SizedBox(height: 16),
          ],
          if (state.feature('voice')) ...[
            const SectionLabel('Voice SOS'),
            MenuGroup(children: [
              MenuRow(
                icon: Icons.record_voice_over_outlined,
                title: 'Say your own phrase',
                subtitle: state.voicePhrase.isEmpty
                    ? 'Not set up. Works during a journey.'
                    : (t.voiceOn ? 'On during journeys: "${state.voicePhrase}"' : 'Off'),
                onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => const VoiceSetupScreen())),
              ),
            ]),
          ],
          if (state.feature('crash') || state.feature('fall')) ...[
            const SectionLabel('Automatic (beta)'),
            AppCard(
              padding: EdgeInsets.zero,
              child: Column(children: [
                if (state.feature('crash'))
                  SwitchListTile(
                    secondary: const IconTile(Icons.directions_car_outlined, size: 40),
                    title: const Text('Drive mode', style: TextStyle(fontWeight: FontWeight.w600)),
                    subtitle: const Text('A hard crash in a vehicle starts a loud countdown'),
                    value: t.driveMode,
                    onChanged: (v) async {
                      if (v &&
                          !await _betaOk('Drive mode (beta)',
                              'When the phone feels a hard crash while you are in a vehicle, a loud $seconds-second countdown starts. If you do not tap "I\'m OK", your guardians get an SOS.\n\nIt may not detect every crash, and a dropped phone can start it.')) {
                        return;
                      }
                      if (v) await Permission.activityRecognition.request();
                      await _save({'driveMode': v});
                    },
                  ),
                if (state.feature('crash') && state.feature('fall')) const Divider(height: 1, indent: 72, color: Color(0xFFF0ECE7)),
                if (state.feature('fall'))
                  SwitchListTile(
                    secondary: const IconTile(Icons.personal_injury_outlined, size: 40),
                    title: const Text('Fall detection', style: TextStyle(fontWeight: FontWeight.w600)),
                    subtitle: const Text('A hard fall and no movement starts a loud countdown'),
                    value: t.fallOn,
                    onChanged: (v) async {
                      if (v &&
                          !await _betaOk('Fall detection (beta)',
                              'If the phone feels a fall and then no movement, a loud $seconds-second countdown starts. If you do not tap "I\'m OK", your guardians get an SOS.\n\nIt may not detect every fall, and dropping the phone can start it.')) {
                        return;
                      }
                      await _save({'fallOn': v});
                    },
                  ),
              ]),
            ),
            const SizedBox(height: 16),
          ],
          const SectionLabel('Discreet mode'),
          MenuGroup(children: [
            MenuRow(
              icon: Icons.visibility_off_outlined,
              title: 'Discreet mode',
              subtitle: 'A plain widget, a quiet countdown, an SOS button in the journey notification',
              onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => const DiscreetModeScreen())),
            ),
          ]),
          const NoticeBox(text: 'Sarthi Rakshak alerts your guardians and helps you call 112. It is not a 24/7 monitoring service.'),
        ]),
      ),
    );
  }
}

/// Voice SOS setup: language, offline model download, phrase said 3 times, test.
class VoiceSetupScreen extends StatefulWidget {
  const VoiceSetupScreen({super.key});

  @override
  State<VoiceSetupScreen> createState() => _VoiceSetupScreenState();
}

class _VoiceSetupScreenState extends State<VoiceSetupScreen> {
  late final AppState _state = AppScope.read(context);
  late final _phrase = TextEditingController(text: _state.voicePhrase);
  late String _lang = _state.voiceLang;
  bool? _hasModel;
  bool _downloading = false;
  int _heard = 0; // times the phrase was heard in setup (3 needed)
  bool _listening = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _checkModel();
  }

  @override
  void dispose() {
    _phrase.dispose();
    super.dispose();
  }

  Future<void> _checkModel() async {
    final has = await _state.engine.voiceHasModel(_lang).catchError((_) => false);
    if (mounted) setState(() => _hasModel = has);
  }

  Future<void> _download() async {
    setState(() {
      _downloading = true;
      _error = null;
    });
    try {
      await _state.engine.voiceDownload(_lang);
      await _checkModel();
    } catch (e) {
      if (mounted) setState(() => _error = 'Could not download. Check your internet and try again.');
    } finally {
      if (mounted) setState(() => _downloading = false);
    }
  }

  String? _phraseProblem() {
    final words = _phrase.text.trim().split(RegExp(r'\s+')).where((w) => w.isNotEmpty).length;
    if (words < 2) return 'Use 2 to 5 words that you would not say by mistake.';
    if (words > 5) return 'Use at most 5 words.';
    return null;
  }

  /// What happened on the last try (green), e.g. "Heard 2 of 3".
  String? _ok;

  Future<void> _listen() async {
    final p = _phraseProblem();
    if (p != null) {
      setState(() => _error = p);
      return;
    }
    setState(() {
      _error = null;
      _ok = null;
    });
    final mic = await Permission.microphone.request();
    if (!mic.isGranted) {
      setState(() => _error = 'Allow the microphone for Voice SOS.');
      if (mic.isPermanentlyDenied) await openAppSettings();
      return;
    }
    // The offline model is needed to listen: download it first if this phone does not have it.
    if (_hasModel != true) {
      await _download();
      if (_hasModel != true) return;
    }
    if (!mounted) return;
    setState(() => _listening = true);
    final status = await _state.engine.voiceTest(_lang, _phrase.text.trim(), seconds: 8).catchError((_) => 'error');
    if (!mounted) return;
    setState(() {
      _listening = false;
      if (status == 'heard') {
        _heard++;
        _ok = _heard >= 3 ? 'Heard 3 of 3. Voice SOS is ready.' : 'Heard $_heard of 3. Say it again.';
      } else if (status.startsWith('unknown:')) {
        _heard = 0;
        _error = 'The ${_lang == 'hi' ? 'Hindi' : 'English'} voice model does not know: '
            '${status.substring(8)}. Use 2 to 5 common ${_lang == 'hi' ? 'Hindi' : 'English'} words.';
      } else {
        _error = switch (status) {
          'not_heard' => 'Did not hear the phrase. Say it clearly, at a normal volume, within 8 seconds.',
          'no_mic' => 'Allow the microphone for Voice SOS.',
          'no_model' => 'The voice model is missing or damaged. Download it again.',
          _ => 'Listening could not start. Close other apps using the microphone and try again.',
        };
        if (status == 'no_model') _hasModel = false;
      }
    });
    if (_heard >= 3 && status == 'heard') {
      try {
        await _state.saveVoicePhrase(_phrase.text.trim(), _lang);
        await _state.saveTriggers({'voiceOn': true});
        if (mounted) showInfo(context, 'Voice SOS is on during journeys.');
      } catch (e) {
        if (mounted) showError(context, e);
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final state = AppScope.of(context);
    final ready = _hasModel == true;
    return Scaffold(
      appBar: AppBar(title: const Text('Voice SOS')),
      body: ListView(padding: const EdgeInsets.fromLTRB(20, 8, 20, 32), children: [
        const Text(
            'During a journey, say your phrase and an SOS countdown starts. The phone listens on its own, offline: nothing you say is recorded or sent.',
            style: TextStyle(color: AppColors.muted, fontSize: 15, height: 1.4)),
        const SizedBox(height: 16),
        if (state.voicePhrase.isNotEmpty)
          AppCard(
            padding: EdgeInsets.zero,
            child: SwitchListTile(
              title: const Text('Voice SOS on journeys', style: TextStyle(fontWeight: FontWeight.w600)),
              subtitle: Text('"${state.voicePhrase}"'),
              value: state.triggers.voiceOn,
              onChanged: (v) => _state.saveTriggers({'voiceOn': v}).catchError((Object e) {
                if (context.mounted) showError(context, e);
              }),
            ),
          ),
        const SizedBox(height: 16),
        const SectionLabel('1. Language'),
        SegmentedButton<String>(
          showSelectedIcon: false,
          segments: const [ButtonSegment(value: 'en', label: Text('English')), ButtonSegment(value: 'hi', label: Text('हिंदी'))],
          selected: {_lang},
          onSelectionChanged: (v) {
            setState(() {
              _lang = v.first;
              _hasModel = null;
              _heard = 0;
            });
            _checkModel();
          },
        ),
        const SizedBox(height: 12),
        AppCard(
          child: Row(children: [
            IconTile(ready ? Icons.check_circle_outline : Icons.download_outlined, color: ready ? AppColors.green : AppColors.red, size: 40),
            const SizedBox(width: 14),
            Expanded(
              child: _downloading
                  ? ValueListenableBuilder<int>(
                      valueListenable: state.voiceDownload,
                      builder: (_, p, _) => Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                        Text('Downloading… $p%', style: const TextStyle(fontWeight: FontWeight.w600)),
                        const SizedBox(height: 6),
                        LinearProgressIndicator(value: p / 100, color: AppColors.red),
                      ]),
                    )
                  : Text(
                      ready ? 'Voice model ready (works offline)' : 'Download the voice model (about 40 MB, once)',
                      style: const TextStyle(fontWeight: FontWeight.w600),
                    ),
            ),
            if (!ready && !_downloading && _hasModel != null) TextButton(onPressed: _download, child: const Text('Download')),
          ]),
        ),
        const SizedBox(height: 16),
        const SectionLabel('2. Your phrase'),
        TextField(
          controller: _phrase,
          maxLength: 60,
          onChanged: (_) => setState(() {
            _heard = 0;
            _ok = null;
          }),
          decoration: InputDecoration(hintText: _lang == 'hi' ? 'उदाहरण: "मुझे बचाओ मदद करो"' : 'e.g. "please help me now"'),
        ),
        const SizedBox(height: 4),
        const SectionLabel('3. Say it 3 times'),
        AppCard(
          child: Column(children: [
            Row(mainAxisAlignment: MainAxisAlignment.center, children: [
              for (var i = 0; i < 3; i++)
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 6),
                  child: Icon(i < _heard ? Icons.check_circle : Icons.radio_button_unchecked, color: i < _heard ? AppColors.green : AppColors.line, size: 32),
                ),
            ]),
            const SizedBox(height: 12),
            SizedBox(
              width: double.infinity,
              child: FilledButton.icon(
                key: const Key('voice-listen'),
                onPressed: _listening || _downloading ? null : _listen,
                icon: Icon(_listening ? Icons.hearing : Icons.mic),
                label: Text(_listening
                    ? 'Listening… say it now'
                    : (_heard >= 3 ? 'Test again' : (ready ? 'Tap, then say your phrase' : 'Download and say your phrase'))),
              ),
            ),
            if (_listening) ...[
              const SizedBox(height: 12),
              const LinearProgressIndicator(color: AppColors.red),
              const SizedBox(height: 6),
              const Text('Listening for 8 seconds', style: TextStyle(color: AppColors.muted, fontSize: 13)),
            ],
          ]),
        ),
        if (_ok != null)
          Padding(
            padding: const EdgeInsets.only(top: 12),
            child: NoticeBox(key: const Key('voice-ok'), text: _ok!, icon: Icons.check_circle_outline, color: AppColors.green, background: AppColors.greenSoft),
          ),
        if (_error != null) Padding(padding: const EdgeInsets.only(top: 12), child: Text(_error!, key: const Key('voice-error'), style: const TextStyle(color: AppColors.red))),
        const SizedBox(height: 16),
        const NoticeBox(text: 'Voice SOS listens only while a journey is on. It may not work in a very noisy place, so keep the SOS button handy.'),
      ]),
    );
  }
}

/// Discreet mode (feature 5).
class DiscreetModeScreen extends StatelessWidget {
  const DiscreetModeScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final state = AppScope.of(context);
    final t = state.triggers;
    Future<void> save(Map<String, Object?> c) => state.saveTriggers(c).catchError((Object e) {
          if (context.mounted) showError(context, e);
        });
    return Scaffold(
      appBar: AppBar(title: const Text('Discreet mode')),
      body: ListView(padding: const EdgeInsets.fromLTRB(20, 8, 20, 32), children: [
        const Text('For when someone may be watching your screen.', style: TextStyle(color: AppColors.muted, fontSize: 15, height: 1.4)),
        const SizedBox(height: 16),
        MenuGroup(label: 'On your home screen', children: [
          MenuRow(
            icon: Icons.widgets_outlined,
            title: 'Add a plain widget',
            subtitle: 'Called "Quick help". One tap starts a quiet SOS countdown.',
            onTap: () async {
              final ok = await state.engine.pinWidget().catchError((_) => false);
              if (context.mounted && !ok) showInfo(context, 'Long-press your home screen → Widgets → Sarthi Rakshak.');
            },
          ),
          MenuRow(
            icon: Icons.add_to_home_screen,
            title: 'Add a shortcut',
            subtitle: 'An icon called "Quick help"',
            onTap: () async {
              final ok = await state.engine.pinShortcut().catchError((_) => false);
              if (context.mounted && !ok) showInfo(context, 'Long-press the Sarthi Rakshak icon and drag "Quick help" to your home screen.');
            },
          ),
        ]),
        AppCard(
          padding: EdgeInsets.zero,
          child: Column(children: [
            SwitchListTile(
              secondary: const IconTile(Icons.volume_off_outlined, size: 40),
              title: const Text('Quiet countdown', style: TextStyle(fontWeight: FontWeight.w600)),
              subtitle: const Text('No sound and a dark screen when an SOS starts'),
              value: t.quietCountdown,
              onChanged: (v) => save({'quietCountdown': v}),
            ),
            const Divider(height: 1, indent: 72, color: Color(0xFFF0ECE7)),
            SwitchListTile(
              secondary: const IconTile(Icons.notifications_active_outlined, size: 40),
              title: const Text('SOS in notification', style: TextStyle(fontWeight: FontWeight.w600)),
              subtitle: const Text('Start an SOS from the journey notification, without opening the app'),
              value: t.journeySosButton,
              onChanged: (v) => save({'journeySosButton': v}),
            ),
          ]),
        ),
      ]),
    );
  }
}
