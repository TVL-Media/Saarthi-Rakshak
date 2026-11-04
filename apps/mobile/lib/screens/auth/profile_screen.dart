import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';

import '../../api/api_client.dart';
import '../../state/app_state.dart';
import '../../theme.dart';
import '../../widgets/common.dart';
import '../../widgets/format.dart';

const bloodGroups = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];

/// Name, photo, blood group (first setup and Settings → Profile).
class ProfileScreen extends StatefulWidget {
  const ProfileScreen({super.key, this.fromSettings = false});
  final bool fromSettings;

  @override
  State<ProfileScreen> createState() => _ProfileScreenState();
}

class _ProfileScreenState extends State<ProfileScreen> {
  late final TextEditingController _name;
  String? _blood;
  String? _error;

  @override
  void initState() {
    super.initState();
    final me = AppScope.read(context).me!;
    _name = TextEditingController(text: me.name ?? '');
    _blood = me.bloodGroup;
  }

  @override
  void dispose() {
    _name.dispose();
    super.dispose();
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
    final state = AppScope.read(context);
    try {
      final me = await state.api.updateProfile(
        name: _name.text.trim(),
        bloodGroup: _blood,
        clearBloodGroup: _blood == null,
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
          const SectionLabel('Blood group'),
          DropdownButtonFormField<String?>(
            initialValue: _blood,
            decoration: const InputDecoration(prefixIcon: Icon(Icons.bloodtype_outlined), hintText: 'Blood group (optional)'),
            items: [
              const DropdownMenuItem(value: null, child: Text('Not given')),
              for (final g in bloodGroups) DropdownMenuItem(value: g, child: Text(g)),
            ],
            onChanged: (v) => setState(() => _blood = v),
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
