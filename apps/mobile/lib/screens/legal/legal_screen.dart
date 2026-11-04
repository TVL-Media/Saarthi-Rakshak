import 'package:flutter/material.dart';

import '../../config.dart';
import '../../theme.dart';
import '../../widgets/common.dart';

/// Privacy Policy and Terms & Conditions, inside the app (no web page needed).
enum LegalPage { privacy, terms }

class LegalScreen extends StatelessWidget {
  const LegalScreen(this.page, {super.key});
  final LegalPage page;

  static void open(BuildContext context, LegalPage page) =>
      Navigator.push(context, MaterialPageRoute(builder: (_) => LegalScreen(page)));

  @override
  Widget build(BuildContext context) {
    final privacy = page == LegalPage.privacy;
    final sections = privacy ? _privacy : _terms;
    return Scaffold(
      appBar: AppBar(title: Text(privacy ? 'Privacy Policy' : 'Terms & Conditions')),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(20, 8, 20, 32),
        children: [
          const Text('Last updated: 4 November 2026', style: TextStyle(color: AppColors.muted)),
          const SizedBox(height: 12),
          const NoticeBox(text: AppConfig.notMonitoring),
          for (final (n, (title, body)) in sections.indexed) ...[
            const SizedBox(height: 24),
            Row(children: [
              Container(
                width: 26,
                height: 26,
                alignment: Alignment.center,
                decoration: BoxDecoration(color: AppColors.redSoft, borderRadius: BorderRadius.circular(8)),
                child: Text('${n + 1}',
                    style: const TextStyle(color: AppColors.red, fontWeight: FontWeight.w800, fontSize: 13)),
              ),
              const SizedBox(width: 10),
              Expanded(child: Text(title, style: const TextStyle(fontSize: 17.5, fontWeight: FontWeight.w800))),
            ]),
            const SizedBox(height: 8),
            Text(body, style: const TextStyle(fontSize: 15, height: 1.55, color: Color(0xFF374151))),
          ],
        ],
      ),
    );
  }
}

const _privacy = <(String, String)>[
  (
    'Who we are',
    'Sarthi Rakshak ("we", "us") is a personal safety app. When you press SOS or start a journey, it alerts '
        'the guardians you choose and helps you call 112. This policy explains what information the app uses, '
        'why, and the choices you have.'
  ),
  (
    'What we collect',
    '• Your mobile number, to log you in with a one-time code (OTP).\n'
        '• Your name, and if you add them, your photo and blood group.\n'
        '• If you add them in My Profile: your gender, date of birth, email, home address and medical notes. '
        'Only you see these in the app; they are not shared with your guardians.\n'
        '• Your guardians: their names, relation and mobile numbers, which you enter or pick from your contacts. '
        'When you pick a contact, the app reads only that one contact.\n'
        '• Your location, only while an SOS or a journey you started is running.\n'
        '• Audio recorded during an SOS (see "Audio recordings").\n'
        '• Phone details that keep protection working: model, Android version, app version, battery level, network '
        'type, which permissions are on, and a notification token.\n'
        '• Problems you report to us from Help & Support.'
  ),
  (
    'When your location is used',
    'The app reads your location to show you where you are on screen. It sends your location to our server only '
        'during an SOS or a journey you start. Your guardians can see it on a private link during the SOS or '
        'journey and for 15 minutes after it ends. We never track you at other times.'
  ),
  (
    'Audio recordings',
    'During an SOS, the app records short audio clips. Each clip is locked (encrypted) on your phone with a key '
        'that never leaves your phone. Only your phone can play them — not your guardians, not our team. Clips are '
        'deleted after 30 days unless you choose to keep them, and the copies on your phone are removed when you '
        'log out.'
  ),
  (
    'Who sees your information',
    '• Your guardians: your first name and your live location during an SOS or journey; during an SOS also your '
        'phone number and blood group, so they can help.\n'
        '• Our support team: only what is needed to keep the service working. They see your live location only '
        'during an active SOS, phone numbers are partly hidden, they can never play your audio, and every look is '
        'recorded.\n'
        '• Service providers who work for us: Google Firebase (login codes and notifications), SMS providers (alert '
        'messages to your guardians) and our hosting provider. They may use your information only to provide '
        'these services.\n'
        '• The police or a court, only when the law requires it.\n'
        'We never sell your information and never use it for advertising.'
  ),
  (
    'SMS from your phone',
    'If there is no internet during an SOS, the app can send the alert as an SMS from your own SIM to your '
        'guardians. Normal SMS charges from your mobile operator may apply.'
  ),
  (
    'Guardians who say no',
    'If someone declines your guardian invite, we delete their number and keep only a one-way code of it, so you '
        'cannot invite them again.'
  ),
  (
    'Where your data is kept',
    'Our live service keeps your data on servers in India. During closed testing, test versions of the app may use '
        'a temporary test server.'
  ),
  (
    'How long we keep it',
    'We keep your account, guardians, journeys and SOS history until you delete your account. Audio clips are '
        'deleted after 30 days unless you keep them.'
  ),
  (
    'Your choices',
    '• Turn permissions on or off at any time in Settings → App Permissions (some protection stops without them).\n'
        '• Remove guardians at any time (except during an SOS).\n'
        '• Delete your account in Settings → Delete My Account. This deletes your profile, photo, guardians, saved '
        'places, journeys, location history and audio. Past SOS alerts are kept without your name or number, for '
        'safety reports.'
  ),
  (
    'Security',
    'Your connection to our server is encrypted, your login is protected, audio is locked to your phone, and our '
        'team works under strict access rules.'
  ),
  (
    'Changes and contact',
    'If we change this policy, we will tell you in the app. Questions or requests: Settings → Help & Support.'
  ),
];

const _terms = <(String, String)>[
  (
    'About these terms',
    'These terms apply when you use the Sarthi Rakshak app. By creating an account you agree to them. If you do '
        'not agree, please do not use the app.'
  ),
  (
    'What the service does',
    'Sarthi Rakshak alerts the guardians you choose when you press SOS, shares your live location with them during '
        'an SOS or a journey you start, checks in with you during journeys, and helps you call 112.'
  ),
  (
    'What it is not',
    'Sarthi Rakshak is not an emergency service and is not a 24/7 monitoring service. Nobody at Sarthi Rakshak '
        'watches your alerts or sends help. In danger, always call 112 (India\'s emergency number).'
  ),
  (
    'It needs your phone to work',
    'Alerts depend on your phone, its battery, its permissions and settings, internet and mobile network, and on '
        'your guardians receiving and reading messages. Some phones stop apps in the background unless you change '
        'their battery settings (see Safety Setup). We cannot promise that every alert is delivered or delivered on '
        'time.'
  ),
  (
    'Your account',
    'Use your own mobile number and keep your phone locked. One account can be used on one phone at a time; '
        'logging in on a new phone logs out the old one. Give correct information.'
  ),
  (
    'Your guardians',
    'Add only people who know you and agree to be your guardian. They receive an SMS invite and can accept or '
        'decline. Do not add someone to annoy or harass them.'
  ),
  (
    'Use it fairly',
    'Do not trigger SOS alerts as a joke or to harass anyone, do not track another person without their '
        'knowledge, and do not misuse the app, its messages or our service. The SOS countdown lets you cancel a '
        'press made by mistake. Fake Call is only a way to leave an uncomfortable situation.'
  ),
  (
    'Audio and location',
    'During an SOS the app records audio and shares your location as described in the Privacy Policy. Please '
        'follow the law where you use these features.'
  ),
  (
    'Our responsibility',
    'We work hard to keep the service reliable but provide it "as it is", without a guarantee that it will always '
        'be available or free of errors. As far as the law allows, we are not responsible for harm caused by an '
        'alert that was delayed or not delivered, or by the actions of guardians or others.'
  ),
  (
    'Stopping and ending',
    'You can stop using the app and delete your account at any time. We may suspend an account that misuses the '
        'service.'
  ),
  (
    'Changes',
    'We may update these terms. We will tell you in the app; continuing to use the app means you accept the new '
        'terms.'
  ),
  (
    'Law and contact',
    'These terms are governed by the laws of India. Questions: Settings → Help & Support.'
  ),
];
