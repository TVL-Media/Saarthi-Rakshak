import 'package:flutter/material.dart';

import '../../config.dart';
import '../../state/app_state.dart';
import '../../theme.dart';
import '../../widgets/common.dart';
import '../legal/legal_screen.dart';

/// Terms and privacy, before anything else (A1 consent).
class ConsentScreen extends StatefulWidget {
  const ConsentScreen({super.key});

  @override
  State<ConsentScreen> createState() => _ConsentScreenState();
}

class _ConsentScreenState extends State<ConsentScreen> {
  bool _agreed = false;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.all(20),
          children: [
            const SizedBox(height: 20),
            const ScreenTitle('Before you start', subtitle: 'How Sarthi Rakshak uses your information'),
            const SizedBox(height: 22),
            const AppCard(
              padding: EdgeInsets.fromLTRB(16, 18, 16, 4),
              child: Column(children: [
                _Point(Icons.location_on_outlined, 'Your location is shared with your guardians only during an SOS or a journey you start.'),
                _Point(Icons.mic_none, 'During an SOS the app records audio. It is locked with a key that stays on this phone; nobody else can listen.'),
                _Point(Icons.sms_outlined, 'Without internet, the app sends your SOS by SMS from your own SIM to your guardians.'),
                _Point(Icons.delete_outline, 'You can delete your account and your data at any time in Settings.'),
              ]),
            ),
            const SizedBox(height: 14),
            const NoticeBox(text: AppConfig.notMonitoring),
            const SizedBox(height: 14),
            Row(children: [
              Checkbox(value: _agreed, activeColor: AppColors.red, onChanged: (v) => setState(() => _agreed = v ?? false)),
              Expanded(
                child: Wrap(children: [
                  const Text('I agree to the '),
                  const _Link('Terms', LegalPage.terms),
                  const Text(' and '),
                  const _Link('Privacy Policy', LegalPage.privacy),
                ]),
              ),
            ]),
            const SizedBox(height: 16),
            BusyButton(
              label: 'Continue',
              onPressed: !_agreed
                  ? null
                  : () async {
                      try {
                        await AppScope.read(context).giveConsent();
                      } catch (e) {
                        if (context.mounted) showError(context, e);
                      }
                    },
            ),
          ],
        ),
      ),
    );
  }
}

class _Point extends StatelessWidget {
  const _Point(this.icon, this.text);
  final IconData icon;
  final String text;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(bottom: 16),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          IconTile(icon),
          const SizedBox(width: 14),
          Expanded(child: Text(text, style: const TextStyle(fontSize: 15, height: 1.45))),
        ]),
      );
}

class _Link extends StatelessWidget {
  const _Link(this.text, this.page);
  final String text;
  final LegalPage page;

  @override
  Widget build(BuildContext context) => GestureDetector(
        onTap: () => LegalScreen.open(context, page),
        child: Text(text, style: const TextStyle(color: AppColors.red, fontWeight: FontWeight.w600)),
      );
}
