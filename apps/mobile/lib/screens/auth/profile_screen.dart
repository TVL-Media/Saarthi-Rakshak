import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';
import 'package:intl/intl.dart';

import '../../api/api_client.dart';
import '../../state/app_state.dart';
import '../../theme.dart';
import '../../widgets/common.dart';
import '../../widgets/format.dart';

const bloodGroups = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];

const genders = [('female', 'Female'), ('male', 'Male'), ('other', 'Other')];

/// Name, photo, blood group (first setup and Settings → Profile). From Settings also the optional
/// details only the user sees: gender, date of birth, email, home address and medical notes.
class ProfileScreen extends StatefulWidget {
  const ProfileScreen({super.key, this.fromSettings = false});
  final bool fromSettings;

  @override
  State<ProfileScreen> createState() => _ProfileScreenState();
}

class _ProfileScreenState extends State<ProfileScreen> {
  late final TextEditingController _name;
  late final TextEditingController _email;
  late final TextEditingController _address;
  late final TextEditingController _medical;
  String? _blood;
  String? _gender;
  DateTime? _birth;
  String? _error;

  @override
  void initState() {
    super.initState();
    final me = AppScope.read(context).me!;
    _name = TextEditingController(text: me.name ?? '');
    _email = TextEditingController(text: me.email ?? '');
    _address = TextEditingController(text: me.homeAddress ?? '');
    _medical = TextEditingController(text: me.medicalNotes ?? '');
    _blood = me.bloodGroup;
    _gender = me.gender;
    _birth = me.dateOfBirth == null ? null : DateTime.tryParse(me.dateOfBirth!);
  }

  @override
  void dispose() {
    _name.dispose();
    _email.dispose();
    _address.dispose();
    _medical.dispose();
    super.dispose();
  }

  Future<void> _pickBirth() async {
    final now = DateTime.now();
    final picked = await showDatePicker(
      context: context,
      initialDate: _birth ?? DateTime(now.year - 25, now.month, now.day),
      firstDate: DateTime(now.year - 120),
      lastDate: now,
      helpText: 'Date of birth',
    );
    if (picked != null) setState(() => _birth = picked);
  }

  /// The optional details (Settings only); empty = cleared.
  Map<String, String?> _details() {
    String? text(TextEditingController c) => c.text.trim().isEmpty ? null : c.text.trim();
    return {
      'gender': _gender,
      'dateOfBirth': _birth == null ? null : DateFormat('yyyy-MM-dd').format(_birth!),
      'email': text(_email),
      'homeAddress': text(_address),
      'medicalNotes': text(_medical),
    };
  }

  /// Same rule as the server: 2–50 characters, letters in any language, spaces and . ' ’ -.
  static String? checkName(String v) {
    final name = v.trim();
    if (name.length < 2) return 'Enter your name (at least 2 characters)';
    if (name.length > 50) return 'Name can be at most 50 characters';
    if (!RegExp(r"^[\p{L}\p{M}][\p{L}\p{M} .'’-]*$", unicode: true).hasMatch(name)) {
      return "Use letters, spaces and . ' - only";
    }
    return null;
  }

  Future<void> _save() async {
    final problem = checkName(_name.text);
    if (problem != null) return setState(() => _error = problem);
    final email = _email.text.trim();
    if (widget.fromSettings && email.isNotEmpty && !RegExp(r'^[^@\s]+@[^@\s]+\.[^@\s]+$').hasMatch(email)) {
      return setState(() => _error = 'Enter a valid email address.');
    }
    final state = AppScope.read(context);
    try {
      final me = await state.api.updateProfile(
        name: _name.text.trim(),
        bloodGroup: _blood,
        clearBloodGroup: _blood == null,
        details: widget.fromSettings ? _details() : const {},
      );
      await state.profileSaved(me);
      if (widget.fromSettings && mounted) Navigator.pop(context);
    } on ApiException catch (e) {
      setState(() => _error = e.message);
    }
  }

  bool _photoBusy = false;

  Future<void> _pickPhoto() async {
    if (_photoBusy) return;
    final state = AppScope.read(context);
    final XFile? file;
    try {
      file = await ImagePicker().pickImage(source: ImageSource.gallery, maxWidth: 800, imageQuality: 80);
    } catch (_) {
      if (mounted) showInfo(context, 'Could not open your photos. Allow photo access for Sarthi Rakshak.');
      return;
    }
    if (file == null) return;
    final bytes = await file.readAsBytes();
    if (bytes.length > 2 * 1024 * 1024) {
      if (mounted) showInfo(context, 'The photo must be at most 2 MB. Choose a smaller one.');
      return;
    }
    setState(() => _photoBusy = true);
    // Shown at once and kept on this phone.
    await state.setLocalPhoto(bytes);
    try {
      final link = await state.api.photoUploadLink(bytes.length);
      await state.api.upload(link, bytes);
      await state.profileSaved(await state.api.savePhoto(link.key));
      if (mounted) showInfo(context, 'Photo updated.');
    } on ApiException catch (e) {
      if (mounted) {
        showInfo(context, e.isOffline || e.code == 'upload_failed' || e.status >= 500
            ? 'Photo saved on this phone. It could not be uploaded to your account right now.'
            : e.message);
      }
    } catch (_) {
      // The file storage could not be reached (e.g. a test server without it).
      if (mounted) showInfo(context, 'Photo saved on this phone. It could not be uploaded to your account right now.');
    } finally {
      if (mounted) setState(() => _photoBusy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final me = AppScope.of(context).me!;
    return Scaffold(
      appBar: AppBar(title: Text(widget.fromSettings ? 'My Profile' : 'Your profile')),
      body: ListView(
        padding: const EdgeInsets.all(20),
        children: [
          if (!widget.fromSettings)
            const Padding(
              padding: EdgeInsets.only(bottom: 20),
              child: Text('Your guardians see your first name in alerts. Blood group helps in an emergency.',
                  style: TextStyle(color: AppColors.muted, fontSize: 15.5)),
            ),
          Center(
            child: GestureDetector(
              onTap: _pickPhoto,
              child: Stack(children: [
                ProfileAvatar(
                  name: me.name ?? '',
                  photoUrl: me.photoUrl,
                  localPhoto: AppScope.of(context).localPhoto,
                  size: 96,
                ),
                if (_photoBusy)
                  const Positioned.fill(child: Center(child: CircularProgressIndicator())),
                const Positioned(
                  right: 0,
                  bottom: 0,
                  child: CircleAvatar(radius: 16, backgroundColor: AppColors.red, child: Icon(Icons.photo_camera, size: 16, color: Colors.white)),
                ),
              ]),
            ),
          ),
          const SizedBox(height: 10),
          const Center(child: Text('Photo (optional)', style: TextStyle(color: AppColors.muted))),
          const SizedBox(height: 24),
          const SectionLabel('Full name'),
          TextField(
            controller: _name,
            textCapitalization: TextCapitalization.words,
            decoration: const InputDecoration(prefixIcon: Icon(Icons.person_outline), hintText: 'Full name'),
          ),
          const SizedBox(height: 18),
          const SectionLabel('Mobile number'),
          // Read-only: the number is the login, it cannot be changed here.
          InputDecorator(
            decoration: const InputDecoration(
              prefixIcon: Icon(Icons.phone_android_outlined),
              suffixIcon: Icon(Icons.lock_outline, size: 18, color: AppColors.muted),
              fillColor: Color(0xFFF3F0EC),
            ),
            child: Text(prettyPhone(me.phone), style: const TextStyle(fontSize: 16, color: AppColors.ink)),
          ),
          const SizedBox(height: 18),
          const SectionLabel('Blood group'),
          DropdownButtonFormField<String?>(
            initialValue: _blood,
            isExpanded: true,
            decoration: const InputDecoration(prefixIcon: Icon(Icons.bloodtype_outlined), hintText: 'Blood group (optional)'),
            items: [
              const DropdownMenuItem(value: null, child: Text('Not given')),
              for (final g in bloodGroups) DropdownMenuItem(value: g, child: Text(g)),
            ],
            onChanged: (v) => setState(() => _blood = v),
          ),
          if (widget.fromSettings) ...[
            const SizedBox(height: 18),
            const SectionLabel('Medical notes'),
            TextField(
              key: const Key('medical'),
              controller: _medical,
              maxLines: 3,
              minLines: 2,
              maxLength: 500,
              textCapitalization: TextCapitalization.sentences,
              decoration: const InputDecoration(
                prefixIcon: Padding(padding: EdgeInsets.only(bottom: 28), child: Icon(Icons.medical_information_outlined)),
                hintText: 'Allergies, conditions or medicines (optional)',
              ),
            ),
            const SizedBox(height: 12),
            const _Divider('More about you'),
            const SizedBox(height: 4),
            const NoticeBox(
              icon: Icons.lock_outline,
              color: Color(0xFF4B5563),
              background: Color(0xFFEFEBE6),
              text: 'Optional. Only you see these details. They are not shared with your guardians.',
            ),
            const SizedBox(height: 18),
            const SectionLabel('Gender'),
            Row(children: [
              for (final (n, (value, label)) in genders.indexed) ...[
                if (n > 0) const SizedBox(width: 8),
                Expanded(
                  child: _Choice(
                    key: Key('gender-$value'),
                    label: label,
                    selected: _gender == value,
                    // Tapping the chosen one again clears it.
                    onTap: () => setState(() => _gender = _gender == value ? null : value),
                  ),
                ),
              ],
            ]),
            const SizedBox(height: 18),
            const SectionLabel('Date of birth'),
            InkWell(
              key: const Key('birth'),
              borderRadius: BorderRadius.circular(14),
              onTap: _pickBirth,
              child: InputDecorator(
                decoration: InputDecoration(
                  prefixIcon: const Icon(Icons.cake_outlined),
                  suffixIcon: _birth == null
                      ? const Icon(Icons.calendar_month_outlined, color: AppColors.muted)
                      : IconButton(
                          tooltip: 'Clear',
                          icon: const Icon(Icons.close, size: 20),
                          onPressed: () => setState(() => _birth = null),
                        ),
                ),
                child: Text(
                  _birth == null ? 'Choose a date' : DateFormat('d MMMM y').format(_birth!),
                  style: TextStyle(fontSize: 16, color: _birth == null ? AppColors.muted : AppColors.ink),
                ),
              ),
            ),
            const SizedBox(height: 18),
            const SectionLabel('Email'),
            TextField(
              key: const Key('email'),
              controller: _email,
              keyboardType: TextInputType.emailAddress,
              autocorrect: false,
              decoration: const InputDecoration(prefixIcon: Icon(Icons.mail_outline), hintText: 'name@example.com'),
            ),
            const SizedBox(height: 18),
            const SectionLabel('Home address'),
            TextField(
              key: const Key('address'),
              controller: _address,
              maxLines: 2,
              minLines: 1,
              maxLength: 300,
              textCapitalization: TextCapitalization.words,
              decoration: const InputDecoration(prefixIcon: Icon(Icons.home_outlined), hintText: 'House, street, area, city'),
            ),
          ],
          if (_error != null) ...[
            const SizedBox(height: 12),
            Text(_error!, style: const TextStyle(color: AppColors.red, fontWeight: FontWeight.w500)),
          ],
          const SizedBox(height: 24),
          BusyButton(label: widget.fromSettings ? 'Save' : 'Continue', onPressed: _save),
        ],
      ),
    );
  }
}

/// The name rule, also used by the Sign up page.
String? checkProfileName(String v) => _ProfileScreenState.checkName(v);

/// Exposes the name rule to tests.
class ProfileScreenTestHook {
  static String? check(String v) => _ProfileScreenState.checkName(v);
}

class _Divider extends StatelessWidget {
  const _Divider(this.text);
  final String text;

  @override
  Widget build(BuildContext context) => Row(children: [
        const Expanded(child: Divider(color: AppColors.line)),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 12),
          child: Text(text, style: const TextStyle(color: AppColors.muted, fontWeight: FontWeight.w600)),
        ),
        const Expanded(child: Divider(color: AppColors.line)),
      ]);
}

/// One of a row of equal-width choice buttons (gender).
class _Choice extends StatelessWidget {
  const _Choice({super.key, required this.label, required this.selected, required this.onTap});
  final String label;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => Material(
        color: selected ? AppColors.red : Colors.white,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(14),
          side: BorderSide(color: selected ? AppColors.red : AppColors.line),
        ),
        child: InkWell(
          borderRadius: BorderRadius.circular(14),
          onTap: onTap,
          child: SizedBox(
            height: 52,
            child: Center(
              child: Text(label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontSize: 15.5,
                    fontWeight: FontWeight.w600,
                    color: selected ? Colors.white : AppColors.ink,
                  )),
            ),
          ),
        ),
      );
}
