import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';

import '../../api/api_client.dart';
import '../../state/app_state.dart';
import '../../theme.dart';
import '../../widgets/common.dart';

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

  Future<void> _pickPhoto() async {
    final state = AppScope.read(context);
    final file = await ImagePicker().pickImage(source: ImageSource.gallery, maxWidth: 800, imageQuality: 80);
    if (file == null) return;
    try {
      final bytes = await file.readAsBytes();
      if (bytes.length > 2 * 1024 * 1024) throw ApiException(400, 'invalid_input', 'The photo must be at most 2 MB.');
      final link = await state.api.photoUploadLink(bytes.length);
      await state.api.upload(link, bytes);
      await state.profileSaved(await state.api.savePhoto(link.key));
      setState(() {});
    } catch (e) {
      if (mounted) showError(context, e);
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
                me.photoUrl != null
                    ? CircleAvatar(radius: 48, backgroundImage: NetworkImage(me.photoUrl!))
                    : Initials(me.name ?? '', size: 96),
                const Positioned(
                  right: 0,
                  bottom: 0,
                  child: CircleAvatar(radius: 16, backgroundColor: AppColors.red, child: Icon(Icons.photo_camera, size: 16, color: Colors.white)),
                ),
              ]),
            ),
          ),
          const SizedBox(height: 8),
          const Center(child: Text('Photo (optional)', style: TextStyle(color: AppColors.muted))),
          const SizedBox(height: 20),
          TextField(
            controller: _name,
            textCapitalization: TextCapitalization.words,
            decoration: const InputDecoration(prefixIcon: Icon(Icons.person_outline), hintText: 'Full name'),
          ),
          const SizedBox(height: 14),
          DropdownButtonFormField<String?>(
            initialValue: _blood,
            decoration: const InputDecoration(prefixIcon: Icon(Icons.bloodtype_outlined), hintText: 'Blood group (optional)'),
            items: [
              const DropdownMenuItem(value: null, child: Text('Not given')),
              for (final g in bloodGroups) DropdownMenuItem(value: g, child: Text(g)),
            ],
            onChanged: (v) => setState(() => _blood = v),
          ),
          const SizedBox(height: 14),
          AppCard(
            child: Row(children: [
              const Icon(Icons.phone_android_outlined, color: AppColors.muted),
              const SizedBox(width: 12),
              Text(me.phone, style: const TextStyle(fontSize: 16)),
            ]),
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

/// Exposes the name rule to tests.
class ProfileScreenTestHook {
  static String? check(String v) => _ProfileScreenState.checkName(v);
}
