import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:image_picker/image_picker.dart';
import 'package:intl/intl.dart';

import '../../api/api_client.dart';
import '../../api/phase2_api.dart';
import '../../state/app_state.dart';
import '../../theme.dart';
import '../../widgets/common.dart';
import '../../widgets/format.dart';
import 'community_screen.dart' show pickArea;

const idTypes = {
  'aadhaar': 'Aadhaar',
  'pan': 'PAN card',
  'driving_licence': 'Driving licence',
  'voter_id': 'Voter ID',
  'passport': 'Passport',
};

/// Become a Rakshak (feature 23): apply as a verified volunteer for your area.
class RakshakScreen extends StatefulWidget {
  const RakshakScreen({super.key});

  @override
  State<RakshakScreen> createState() => _RakshakScreenState();
}

class _RakshakScreenState extends State<RakshakScreen> {
  late final AppState _state = AppScope.read(context);
  late Future<RakshakApplication?> _future = _state.api.rakshakApplication();

  void _reload() => setState(() => _future = _state.api.rakshakApplication());

  Future<void> _withdraw() async {
    if (!await confirm(context, 'Withdraw your application?', 'Your documents will be deleted.', yes: 'Withdraw', danger: true)) return;
    try {
      await _state.api.rakshakWithdraw();
      _reload();
    } catch (e) {
      if (mounted) showError(context, e);
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: const Text('Become a Rakshak')),
        body: FutureBuilder<RakshakApplication?>(
          future: _future,
          builder: (context, snap) {
            if (snap.connectionState != ConnectionState.done) return const Center(child: CircularProgressIndicator());
            if (snap.hasError) {
              return Center(
                child: Column(mainAxisSize: MainAxisSize.min, children: [
                  const Text('Could not load. Please try again.'),
                  const SizedBox(height: 12),
                  OutlinedButton(onPressed: _reload, child: const Text('Try again')),
                ]),
              );
            }
            final app = snap.data;
            if (app == null || app.status == 'withdrawn' || app.status == 'rejected') {
              return _Intro(previous: app, onApply: () async {
                await Navigator.push(context, MaterialPageRoute(builder: (_) => const RakshakFormScreen()));
                _reload();
              });
            }
            final (label, color, text) = switch (app.status) {
              'approved' => ('Approved', AppColors.green, 'You are a verified Rakshak for ${app.area}. Thank you for keeping people safe.'),
              _ => ('Under review', AppColors.amber, 'We are checking your documents. This usually takes a few days. We will notify you.'),
            };
            return ListView(padding: const EdgeInsets.fromLTRB(20, 8, 20, 32), children: [
              AppCard(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Row(children: [
                    const IconTile(Icons.shield_outlined, size: 44),
                    const SizedBox(width: 12),
                    Expanded(child: Text(app.area, style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w700))),
                    StatusPill(label, color: color),
                  ]),
                  const SizedBox(height: 12),
                  Text(text, style: const TextStyle(fontSize: 15, height: 1.45)),
                  const SizedBox(height: 8),
                  Text('Applied ${dateTime(app.createdAt)}', style: const TextStyle(color: AppColors.muted, fontSize: 13)),
                ]),
              ),
              const SizedBox(height: 16),
              if (app.status == 'under_review')
                MenuGroup(children: [MenuRow(icon: Icons.undo, title: 'Withdraw application', danger: true, onTap: _withdraw)]),
            ]);
          },
        ),
      );
}

class _Intro extends StatelessWidget {
  const _Intro({required this.previous, required this.onApply});
  final RakshakApplication? previous;
  final VoidCallback onApply;

  @override
  Widget build(BuildContext context) => ListView(padding: const EdgeInsets.fromLTRB(20, 8, 20, 32), children: [
        Container(
          padding: const EdgeInsets.all(20),
          decoration: BoxDecoration(color: AppColors.night, borderRadius: BorderRadius.circular(20)),
          child: Row(children: [
            IconTile(Icons.volunteer_activism_outlined, color: Colors.white, background: Colors.white.withValues(alpha: 0.12), size: 52),
            const SizedBox(width: 14),
            const Expanded(
              child: Text('Help keep your area safe as a verified volunteer.',
                  style: TextStyle(color: Colors.white, fontSize: 17, fontWeight: FontWeight.w700, height: 1.35)),
            ),
          ]),
        ),
        const SizedBox(height: 20),
        if (previous?.status == 'rejected')
          Padding(
            padding: const EdgeInsets.only(bottom: 16),
            child: NoticeBox(
              text: 'Your last application was not approved${previous!.reason == null ? '' : ': ${previous!.reason}'}. You can apply again.',
              icon: Icons.info_outline,
            ),
          ),
        const SectionLabel('Who can apply'),
        for (final (icon, t) in const [
          (Icons.cake_outlined, '18 years or older'),
          (Icons.badge_outlined, 'A government ID (Aadhaar, PAN, driving licence, voter ID or passport)'),
          (Icons.place_outlined, 'Living or working in Noida'),
          (Icons.verified_user_outlined, 'Agree to identity and background checks'),
        ])
          Padding(
            padding: const EdgeInsets.only(bottom: 10),
            child: Row(children: [
              IconTile(icon, size: 36),
              const SizedBox(width: 12),
              Expanded(child: Text(t, style: const TextStyle(fontSize: 15))),
            ]),
          ),
        const SizedBox(height: 12),
        const NoticeBox(
          text: 'We keep only the last 4 digits of your ID number. Your documents are seen only by our verification team and deleted if you withdraw.',
          icon: Icons.lock_outline,
          color: AppColors.green,
          background: AppColors.greenSoft,
        ),
        const SizedBox(height: 20),
        FilledButton(key: const Key('rakshak-apply'), onPressed: onApply, child: const Text('Apply')),
      ]);
}

class RakshakFormScreen extends StatefulWidget {
  const RakshakFormScreen({super.key});

  @override
  State<RakshakFormScreen> createState() => _RakshakFormScreenState();
}

class _RakshakFormScreenState extends State<RakshakFormScreen> {
  late final AppState _state = AppScope.read(context);
  late final _name = TextEditingController(text: _state.me?.name ?? '');
  late final _address = TextEditingController(text: _state.me?.homeAddress ?? '');
  final _last4 = TextEditingController();
  final _why = TextEditingController();
  late DateTime? _dob = DateTime.tryParse(_state.me?.dateOfBirth ?? '');
  String? _area;
  String _idType = 'aadhaar';
  final Map<String, XFile> _docs = {};
  bool _agree = false;
  String? _error;
  List<String> _areas = const [];

  @override
  void initState() {
    super.initState();
    _state.api.communityAreas().then((a) {
      if (mounted) setState(() => _areas = a);
    }).catchError((_) {});
  }

  @override
  void dispose() {
    _name.dispose();
    _address.dispose();
    _last4.dispose();
    _why.dispose();
    super.dispose();
  }

  bool get _adult {
    final d = _dob;
    if (d == null) return false;
    final now = DateTime.now();
    final eighteen = DateTime(d.year + 18, d.month, d.day);
    return !eighteen.isAfter(now);
  }

  Future<void> _pick(String doc) async {
    final f = await ImagePicker().pickImage(
      source: ImageSource.camera,
      preferredCameraDevice: doc == 'selfie' ? CameraDevice.front : CameraDevice.rear,
      maxWidth: 1600,
      maxHeight: 1600,
      imageQuality: 80,
    );
    if (f != null) setState(() => _docs[doc] = f);
  }

  Future<void> _submit() async {
    String? problem;
    if (_name.text.trim().length < 2) problem = 'Enter your full name.';
    if (problem == null && !_adult) problem = 'You must be 18 or older.';
    if (problem == null && _address.text.trim().length < 10) problem = 'Enter your full address.';
    if (problem == null && _area == null) problem = 'Choose your area.';
    if (problem == null && !RegExp(r'^[0-9A-Za-z]{4}$').hasMatch(_last4.text.trim())) problem = 'Enter the last 4 characters of your ID number.';
    if (problem == null && _why.text.trim().length < 20) problem = 'Tell us a little more about why you want to help (at least 20 characters).';
    if (problem == null && _docs.length < 3) problem = 'Add both sides of your ID and a selfie.';
    if (problem == null && !_agree) problem = 'Please agree to the verification checks.';
    if (problem != null) {
      setState(() => _error = problem);
      return;
    }
    setState(() => _error = null);
    try {
      final keys = <String, String>{};
      for (final e in _docs.entries) {
        final size = await File(e.value.path).length();
        final link = await _state.api.rakshakDocLink(e.key, size);
        await _state.api.uploadFile(link, e.value.path);
        keys[e.key] = link.key;
      }
      await _state.api.rakshakApply({
        'fullName': _name.text.trim(),
        'dateOfBirth': DateFormat('yyyy-MM-dd').format(_dob!),
        'address': _address.text.trim(),
        'area': _area,
        'idType': _idType,
        'idLast4': _last4.text.trim().toUpperCase(),
        'motivation': _why.text.trim(),
        'documents': keys,
        'agreeToChecks': true,
      });
      if (mounted) {
        showInfo(context, 'Application sent. We will notify you.');
        Navigator.pop(context);
      }
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    }
  }

  Widget _docTile(String key, String label, IconData icon) {
    final f = _docs[key];
    return Expanded(
      child: AppCard(
        onTap: () => _pick(key),
        padding: const EdgeInsets.all(8),
        child: SizedBox(
          height: 96,
          child: f == null
              ? Column(mainAxisAlignment: MainAxisAlignment.center, children: [
                  Icon(icon, color: AppColors.red),
                  const SizedBox(height: 6),
                  Text(label, textAlign: TextAlign.center, style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600)),
                ])
              : ClipRRect(borderRadius: BorderRadius.circular(10), child: Image.file(File(f.path), fit: BoxFit.cover, width: double.infinity)),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: const Text('Rakshak application')),
        body: ListView(padding: const EdgeInsets.fromLTRB(20, 8, 20, 32), children: [
          TextField(controller: _name, maxLength: 80, decoration: const InputDecoration(labelText: 'Full name (as on your ID)')),
          AppCard(
            padding: EdgeInsets.zero,
            child: MenuRow(
              icon: Icons.cake_outlined,
              title: 'Date of birth',
              subtitle: _dob == null ? 'Choose' : DateFormat('d MMM y').format(_dob!),
              onTap: () async {
                final now = DateTime.now();
                final d = await showDatePicker(
                  context: context,
                  initialDate: _dob ?? DateTime(now.year - 25),
                  firstDate: DateTime(1920),
                  lastDate: now,
                );
                if (d != null) setState(() => _dob = d);
              },
            ),
          ),
          const SizedBox(height: 16),
          TextField(controller: _address, maxLength: 300, maxLines: 2, decoration: const InputDecoration(labelText: 'Address')),
          AppCard(
            padding: EdgeInsets.zero,
            child: MenuRow(
              icon: Icons.place_outlined,
              accent: true,
              title: _area ?? 'Area you will help in',
              subtitle: _area == null ? 'Sector or area in Noida' : null,
              onTap: () async {
                final a = await pickArea(context, _areas);
                if (a != null && a.isNotEmpty) setState(() => _area = a);
              },
            ),
          ),
          const SizedBox(height: 16),
          const SectionLabel('Your ID'),
          Wrap(spacing: 8, runSpacing: 8, children: [
            for (final e in idTypes.entries) PillChoice(label: e.value, selected: _idType == e.key, onSelected: (_) => setState(() => _idType = e.key)),
          ]),
          const SizedBox(height: 12),
          TextField(
            controller: _last4,
            maxLength: 4,
            textCapitalization: TextCapitalization.characters,
            inputFormatters: [FilteringTextInputFormatter.allow(RegExp('[0-9A-Za-z]'))],
            decoration: const InputDecoration(labelText: 'Last 4 characters of the ID number', helperText: 'Never the full number'),
          ),
          const SizedBox(height: 8),
          Row(children: [
            _docTile('idFront', 'ID front', Icons.badge_outlined),
            const SizedBox(width: 10),
            _docTile('idBack', 'ID back', Icons.flip_outlined),
            const SizedBox(width: 10),
            _docTile('selfie', 'Selfie', Icons.face_outlined),
          ]),
          const SizedBox(height: 6),
          const Text('Cover the middle digits of your Aadhaar before taking the photo (masked Aadhaar).',
              style: TextStyle(color: AppColors.muted, fontSize: 13)),
          const SizedBox(height: 16),
          TextField(controller: _why, minLines: 3, maxLines: 6, maxLength: 1000, decoration: const InputDecoration(labelText: 'Why do you want to be a Rakshak?')),
          CheckboxListTile(
            contentPadding: EdgeInsets.zero,
            controlAffinity: ListTileControlAffinity.leading,
            value: _agree,
            onChanged: (v) => setState(() => _agree = v ?? false),
            title: const Text('I agree to identity and background checks, and confirm the details are true.', style: TextStyle(fontSize: 14.5)),
          ),
          if (_error != null) Padding(padding: const EdgeInsets.only(top: 8), child: Text(_error!, style: const TextStyle(color: AppColors.red))),
          const SizedBox(height: 16),
          BusyButton(label: 'Send application', onPressed: _submit),
        ]),
      );
}
