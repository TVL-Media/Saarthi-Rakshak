import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../api/phase4_api.dart';
import '../../state/app_state.dart';
import '../../theme.dart';
import '../../widgets/common.dart';
import '../fakecall/fake_call_screen.dart';
import '../sos/sos_countdown_screen.dart';
import 'phase4_common.dart';
import 'safe_places_screen.dart';

/// Night Mode: a short list of the tools that matter most at night. Turning it on or off never
/// starts SOS, tracking or recording, and a running SOS or journey carries on either way.
class ToolsScreen extends StatefulWidget {
  const ToolsScreen({super.key});
  @override
  State<ToolsScreen> createState() => _ToolsScreenState();
}

class _ToolsScreenState extends State<ToolsScreen> {
  late final AppState _state = AppScope.read(context);
  bool _night = false;

  /// The user tapped before the saved state arrived: their choice wins.
  bool _touched = false;

  /// Only the newest tap may undo the switch if saving fails (fast taps save in order).
  int _tapNo = 0;

  @override
  void initState() {
    super.initState();
    _state.api.nightModeActive().then((v) {
      if (mounted && !_touched) setState(() => _night = v);
    }).catchError((_) {});
  }

  /// Moves at once and saves in the background (it used to stay greyed out while the phone asked
  /// the server, which felt stuck). Goes back, with a message, only if saving fails.
  Future<void> _toggle(bool on) async {
    _touched = true;
    final no = ++_tapNo;
    setState(() => _night = on);
    try {
      await _state.api.setNightMode(on);
    } catch (e) {
      if (mounted && no == _tapNo) {
        setState(() => _night = !on);
        showError(context, e);
      }
    }
  }

  Future<void> _shareLocation() async {
    final (pos, problem) = await p4Position();
    if (!mounted) return;
    if (pos == null) return showInfo(context, problem ?? 'Location not available.');
    final url = 'https://www.google.com/maps/search/?api=1&query=${pos.latitude},${pos.longitude}';
    await launchUrl(Uri.parse('sms:?body=${Uri.encodeComponent('I am here: $url')}'));
  }

  @override
  Widget build(BuildContext context) {
    final dark = _night;
    final bg = dark ? const Color(0xFF111827) : AppColors.cream;
    final fg = dark ? Colors.white : AppColors.ink;
    return Scaffold(
      backgroundColor: bg,
      appBar: AppBar(
        title: const Text('Essential Safety Tools'),
        backgroundColor: bg,
        foregroundColor: fg,
        actions: [IconButton(tooltip: 'Close', icon: const Icon(Icons.close), onPressed: () => Navigator.pop(context))],
      ),
      body: ListView(padding: const EdgeInsets.all(16), children: [
        SwitchListTile(
          value: _night,
          onChanged: _toggle,
          title: Text('Night Mode', style: TextStyle(color: fg, fontWeight: FontWeight.w700)),
          subtitle: Text('Darker screen with the tools you need first. It never starts SOS or tracking by itself.',
              style: TextStyle(color: dark ? Colors.white70 : AppColors.muted)),
        ),
        const SizedBox(height: 8),
        SizedBox(
          height: 96,
          // Just the word: the "sos" icon is itself the letters SOS, which showed "SOS SOS".
          child: FilledButton(
            style: FilledButton.styleFrom(backgroundColor: AppColors.red, textStyle: const TextStyle(fontSize: 28, fontWeight: FontWeight.w800, letterSpacing: 2)),
            onPressed: () => Navigator.push(context, MaterialPageRoute(builder: (_) => const SosCountdownScreen(trigger: 'button'))),
            child: const Text('SOS'),
          ),
        ),
        const SizedBox(height: 12),
        _tool(Icons.call, 'Call 112', 'Opens your phone dialler.', () => launchUrl(Uri.parse('tel:112')), dark),
        _tool(Icons.share_location, 'Share my live location', 'Sends a map link by message. Guardians also get it automatically in an SOS.', _shareLocation, dark),
        _tool(Icons.phone_in_talk_outlined, 'Fake call', 'A pretend call to help you leave. It does not call anyone.',
            () => Navigator.push(context, MaterialPageRoute(builder: (_) => const FakeCallScreen())), dark),
        if (_state.feature4('safe_places'))
          _tool(Icons.local_police_outlined, 'Safe places', 'Police, hospitals, pharmacies and help desks near you.',
              () => Navigator.push(context, MaterialPageRoute(builder: (_) => const SafePlacesScreen())), dark),
        _tool(Icons.group, 'My guardians', '${_state.guardians.length} guardian(s) will be alerted in an SOS.', () => Navigator.pop(context), dark),
        const SizedBox(height: 8),
        Text('Sarthi Rakshak alerts your guardians and helps you call 112. It is not a 24/7 monitoring service.',
            style: TextStyle(color: dark ? Colors.white60 : AppColors.muted, fontSize: 13)),
      ]),
    );
  }

  Widget _tool(IconData icon, String title, String note, VoidCallback onTap, bool dark) => Padding(
        padding: const EdgeInsets.only(bottom: 10),
        child: AppCard(
          color: dark ? const Color(0xFF1F2937) : null,
          onTap: onTap,
          child: Row(children: [
            Icon(icon, size: 30, color: dark ? Colors.white : AppColors.red),
            const SizedBox(width: 14),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(title, style: TextStyle(fontSize: 17, fontWeight: FontWeight.w700, color: dark ? Colors.white : AppColors.ink)),
                Text(note, style: TextStyle(fontSize: 13.5, color: dark ? Colors.white70 : AppColors.muted)),
              ]),
            ),
          ]),
        ),
      );
}
