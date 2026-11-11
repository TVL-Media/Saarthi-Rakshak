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
          const Text('Last updated: 11 November 2026', style: TextStyle(color: AppColors.muted)),
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
        '• Your location while an SOS or a journey you started is running, and all day only if you turn on '
        'Full-day location.\n'
        '• Photos the phone takes during an SOS, if you allow the camera.\n'
        '• What you save in Mere Saboot (your evidence vault). It is encrypted on your phone; we cannot open it.\n'
        '• Community reports you send, and if you apply to be a Rakshak: your name, date of birth, address, area, '
        'the type and last 4 characters of your ID, photos of your ID and a selfie.\n'
        '• Whether your phone is still, walking or in a vehicle (activity recognition), to save battery and for '
        'Drive mode. This stays on your phone.\n'
        '• Audio recorded during an SOS (see "Audio recordings").\n'
        '• Phone details that keep protection working: model, Android version, app version, battery level, network '
        'type, which permissions are on, and a notification token.\n'
        '• Problems you report to us from Help & Support.'
  ),
  (
    'When your location is used',
    'The app reads your location to show you where you are on screen. It sends your location to our server '
        'during an SOS or a journey you start. Your guardians can see it on a private link during the SOS or '
        'journey and for 15 minutes after it ends.\n'
        'Full-day location is off unless you turn it on. When it is on, your phone records your location every few '
        'minutes, also when the app is closed, so you can see your own timeline. Only you can see it; guardians '
        'do not get it and our team sees only counts. It is deleted after 7, 30 or 90 days (you choose), and you '
        'can pause it, delete a day or delete everything at any time.'
  ),
  (
    'Audio recordings',
    'During an SOS, the app records short audio clips. Each clip is locked (encrypted) on your phone with a key '
        'that never leaves your phone. Only your phone can play them — not your guardians, not our team. Clips are '
        'deleted after 30 days unless you choose to keep them, and the copies on your phone are removed when you '
        'log out.'
  ),
  (
    'SOS triggers and the microphone',
    'If you turn them on, the app can start an SOS countdown when you shake the phone, when it feels a crash or '
        'a fall, or when you say your own phrase during a journey. Voice SOS works offline on your phone: what you '
        'say is not recorded or sent anywhere, and your phrase stays on your phone.'
  ),
  (
    'SOS photos',
    'While the SOS screen is open, the phone can take photos with the back and front camera. They are shared with '
        'your guardians on the live page and deleted from our server after 30 days. You can save copies in Mere '
        'Saboot first.'
  ),
  (
    'Mere Saboot (evidence vault)',
    'Files, recordings and details you save in Mere Saboot are encrypted on your phone before upload, with a key '
        'only you hold (opened by your fingerprint, face or phone PIN, or your 12-word recovery phrase). We cannot '
        'open them, and if you lose your recovery phrase and your phone, nobody can. A record of when items were '
        'received and opened is kept so you can show they were not changed.'
  ),
  (
    'Community and Rakshak',
    'Community reports are checked by our team before they are shown, without your name. Our team may edit them, '
        'blur or remove a photo, or not publish them. Rakshak applications are seen only by our verification team; '
        'we never keep a full Aadhaar number, and documents are deleted if you withdraw or 90 days after a '
        'rejection.'
  ),
  (
    'Who sees your information',
    '• Your guardians: your first name and your live location during an SOS or journey; during an SOS also your '
        'phone number and blood group, so they can help.\n'
        '• Our support team: only what is needed to keep the service working. They see your live location only '
        'during an active SOS, phone numbers are partly hidden, they can never play your audio, and every look is '
        'recorded.\n'
        '• Service providers who work for us: Google Firebase (login codes and notifications), Google Play '
        '(payments, if paid plans start), SMS providers (alert messages to your guardians) and our hosting '
        'provider. They may use your information only to provide '
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
    'We keep your account, guardians, journeys and SOS history until you delete your account. Audio clips (unless '
        'you keep them) and SOS photos are deleted after 30 days. Full-day location is deleted after the time you '
        'choose. Mere Saboot items stay until you delete them (each item is protected from deletion for '
        'a set time after it is saved, 90 days at present, so someone who takes your phone cannot erase it). '
        'Deleting your account still deletes everything.'
  ),
  (
    'Your choices',
    '• Turn permissions on or off at any time in Settings → App Permissions (some protection stops without them).\n'
        '• Remove guardians at any time (except during an SOS).\n'
        '• Delete your account in Settings → Delete My Account. This deletes your profile, photo, guardians, saved '
        'places, journeys, location history, audio, SOS photos, Mere Saboot, community reports and any Rakshak '
        'application. Past SOS alerts are kept without your name or number, for '
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
    'Automatic SOS (beta)',
    'Shake, voice, Drive mode and fall detection may not notice every emergency and can sometimes start by '
        'mistake. Each starts a countdown you can cancel. Do not rely on them alone; keep the SOS button and 112 '
        'at hand.'
  ),
  (
    'Mere Saboot and your recovery phrase',
    'You are responsible for keeping your 12-word recovery phrase safe. Without it and your phone, saved evidence '
        'cannot be recovered by anyone, including us. Save only material you have the right to keep, and follow '
        'the law when you share it.'
  ),
  (
    'Community reports',
    'Report only what you have seen, without names, phone numbers, faces or number plates. Do not post false, '
        'hateful or private information. We may edit, refuse or remove any report. To complain about a post, '
        'report it in the app or contact our grievance officer through Help & Support.'
  ),
  (
    'Plans and payments',
    'All features are free for now. If paid plans start, prices are shown before you pay, payment and renewals '
        'go through Google Play, and refunds follow Google Play\'s policy. You can cancel in Google Play at any time.'
  ),
  (
    'Audio and location',
    'During an SOS the app records audio, can take photos and shares your location as described in the Privacy '
        'Policy. Please '
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
