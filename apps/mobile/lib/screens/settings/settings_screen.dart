import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:geolocator/geolocator.dart';
import 'package:permission_handler/permission_handler.dart' show openAppSettings;
import 'package:url_launcher/url_launcher.dart';

import '../../api/api_client.dart';
import '../../api/maps_service.dart';
import '../../api/models.dart';
import '../../config.dart';
import '../../state/app_state.dart';
import '../../theme.dart';
import '../../widgets/common.dart';
import '../../widgets/format.dart';
import '../auth/phone_otp.dart';
import '../auth/profile_screen.dart';
import '../guardians/guardians_screen.dart';
import '../setup/safety_setup_screen.dart';

/// Settings tab (design frame 42 / "My Profile", Phase 1 items only).
class SettingsScreen extends StatelessWidget {
  const SettingsScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final state = AppScope.of(context);
    final me = state.me;
    void open(Widget w) => Navigator.push(context, MaterialPageRoute(builder: (_) => w));

    return SafeArea(
      child: ListView(
        padding: const EdgeInsets.fromLTRB(20, 14, 20, 24),
        children: [
          const SizedBox(
            height: 44,
            child: Center(child: Text('Settings', style: TextStyle(fontSize: 22, fontWeight: FontWeight.w700))),
          ),
          const SizedBox(height: 14),
          if (me != null) ...[
            _Row(
              onTap: () => open(const ProfileScreen(fromSettings: true)),
              padding: const EdgeInsets.fromLTRB(16, 14, 14, 14),
              child: Row(children: [
                me.photoUrl != null
                    ? CircleAvatar(radius: 28, backgroundImage: NetworkImage(me.photoUrl!))
                    : Initials(me.name ?? '', size: 56),
                const SizedBox(width: 14),
                Expanded(
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text(me.name ?? '', style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w700)),
                    const SizedBox(height: 2),
                    Text(prettyPhone(me.phone), style: const TextStyle(color: AppColors.muted, fontSize: 14.5)),
                  ]),
                ),
                const Icon(Icons.chevron_right, color: Color(0xFF4B5563)),
              ]),
            ),
            const SizedBox(height: 6),
          ],
          _Item(Icons.health_and_safety_outlined, 'Safety Setup', () => open(const SafetySetupScreen())),
          _Item(Icons.admin_panel_settings_outlined, 'App Permissions', openAppSettings),
          _Item(Icons.people_outline, 'Guardians', () => open(const GuardiansScreen())),
          _Item(Icons.location_on_outlined, 'Saved Places', () => open(const SavedPlacesScreen())),
          _Item(Icons.shield_outlined, 'Privacy Policy', () => launchUrl(Uri.parse(AppConfig.privacyUrl))),
          _Item(Icons.description_outlined, 'Terms & Conditions', () => launchUrl(Uri.parse(AppConfig.termsUrl))),
          _Item(Icons.help_outline, 'Help & Support', () => open(const ReportProblemScreen())),
          _Item(Icons.logout, 'Log Out', () async {
            if (await confirm(context, 'Log out?', 'Protection stops on this phone until you log in again.', yes: 'Log out')) {
              await state.logout();
            }
          }, danger: true),
          _Item(Icons.delete_outline, 'Delete My Account', () => open(const DeleteAccountScreen()), danger: true),
          const SizedBox(height: 18),
          const Text(AppConfig.notMonitoring, textAlign: TextAlign.center, style: TextStyle(color: AppColors.muted, fontSize: 13)),
        ],
      ),
    );
  }
}

/// A white rounded settings row (design frame 42).
class _Row extends StatelessWidget {
  const _Row({required this.child, required this.onTap, this.padding = const EdgeInsets.symmetric(horizontal: 16, vertical: 15)});
  final Widget child;
  final VoidCallback onTap;
  final EdgeInsetsGeometry padding;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(bottom: 10),
        child: Material(
          color: Colors.white,
          borderRadius: BorderRadius.circular(16),
          shadowColor: Colors.black.withValues(alpha: 0.2),
          elevation: 0.6,
          child: InkWell(
            borderRadius: BorderRadius.circular(16),
            onTap: onTap,
            child: Padding(padding: padding, child: child),
          ),
        ),
      );
}

class _Item extends StatelessWidget {
  const _Item(this.icon, this.label, this.onTap, {this.danger = false});
  final IconData icon;
  final String label;
  final VoidCallback onTap;
  final bool danger;

  @override
  Widget build(BuildContext context) {
    final color = danger ? AppColors.red : AppColors.ink;
    return _Row(
      onTap: onTap,
      child: Row(children: [
        Icon(icon, color: color, size: 24),
        const SizedBox(width: 18),
        Expanded(child: Text(label, style: TextStyle(fontSize: 16, color: color, fontWeight: danger ? FontWeight.w600 : FontWeight.w500))),
        const Icon(Icons.chevron_right, color: Color(0xFF4B5563)),
      ]),
    );
  }
}

/// Home, Work and other places for Start journey.
class SavedPlacesScreen extends StatefulWidget {
  const SavedPlacesScreen({super.key});

  @override
  State<SavedPlacesScreen> createState() => _SavedPlacesScreenState();
}

class _SavedPlacesScreenState extends State<SavedPlacesScreen> {
  List<SavedPlace>? _places;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final p = await AppScope.read(context).api.places();
      if (mounted) setState(() => _places = p);
    } catch (e) {
      if (mounted) showError(context, e);
    }
  }

  Future<void> _add(String label) async {
    final saved = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      backgroundColor: AppColors.cream,
      builder: (_) => _PlaceForm(label: label),
    );
    if (saved == true) _load();
  }

  @override
  Widget build(BuildContext context) {
    final places = _places;
    final home = places?.where((p) => p.label == 'home').firstOrNull;
    final work = places?.where((p) => p.label == 'work').firstOrNull;
    return Scaffold(
      appBar: AppBar(title: const Text('Saved places')),
      body: places == null
          ? const Center(child: CircularProgressIndicator())
          : ListView(padding: const EdgeInsets.all(20), children: [
              _PlaceRow(icon: Icons.home, title: 'Home', place: home, onEdit: () => _add('home'), onDelete: home == null ? null : () => _delete(home)),
              _PlaceRow(icon: Icons.work, title: 'Work', place: work, onEdit: () => _add('work'), onDelete: work == null ? null : () => _delete(work)),
              for (final p in places.where((p) => p.label == 'other'))
                _PlaceRow(icon: Icons.place, title: p.name, place: p, onEdit: null, onDelete: () => _delete(p)),
              const SizedBox(height: 12),
              OutlinedButton.icon(onPressed: () => _add('other'), icon: const Icon(Icons.add), label: const Text('Add a place')),
            ]),
    );
  }

  Future<void> _delete(SavedPlace p) async {
    try {
      await AppScope.read(context).api.removePlace(p.id);
      _load();
    } catch (e) {
      if (mounted) showError(context, e);
    }
  }
}

class _PlaceRow extends StatelessWidget {
  const _PlaceRow({required this.icon, required this.title, required this.place, required this.onEdit, required this.onDelete});
  final IconData icon;
  final String title;
  final SavedPlace? place;
  final VoidCallback? onEdit;
  final VoidCallback? onDelete;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(bottom: 8),
        child: AppCard(
          onTap: onEdit,
          child: Row(children: [
            CircleAvatar(backgroundColor: AppColors.redSoft, child: Icon(icon, color: AppColors.red)),
            const SizedBox(width: 12),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(title, style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 16)),
                Text(place?.address ?? place?.name ?? 'Not set', style: const TextStyle(color: AppColors.muted), maxLines: 1, overflow: TextOverflow.ellipsis),
              ]),
            ),
            if (onDelete != null) IconButton(onPressed: onDelete, icon: const Icon(Icons.delete_outline)),
          ]),
        ),
      );
}

class _PlaceForm extends StatefulWidget {
  const _PlaceForm({required this.label});
  final String label;

  @override
  State<_PlaceForm> createState() => _PlaceFormState();
}

class _PlaceFormState extends State<_PlaceForm> {
  final _maps = MapsService();
  late final _name = TextEditingController(text: widget.label == 'home' ? 'Home' : widget.label == 'work' ? 'Work' : '');
  final _search = TextEditingController();
  List<PlaceResult> _results = const [];
  PlaceResult? _picked;
  String? _error;

  Future<void> _useHere() async {
    try {
      final pos = await Geolocator.getCurrentPosition(locationSettings: const LocationSettings(timeLimit: Duration(seconds: 15)));
      setState(() => _picked = PlaceResult(_name.text, 'My current location', pos.latitude, pos.longitude));
    } catch (_) {
      setState(() => _error = 'Could not get your location. Turn location on and try again.');
    }
  }

  Future<void> _save() async {
    final name = _name.text.trim();
    if (name.isEmpty) return setState(() => _error = 'Enter a name.');
    if (_picked == null) return setState(() => _error = 'Search for the place or use your current location.');
    try {
      await AppScope.read(context).api.savePlace(widget.label, name, _picked!.lat, _picked!.lng, address: _picked!.address);
      if (mounted) Navigator.pop(context, true);
    } on ApiException catch (e) {
      setState(() => _error = e.message);
    }
  }

  @override
  Widget build(BuildContext context) => Padding(
        padding: EdgeInsets.fromLTRB(20, 20, 20, 20 + MediaQuery.of(context).viewInsets.bottom),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          const Text('Save a place', style: TextStyle(fontSize: 22, fontWeight: FontWeight.w800)),
          const SizedBox(height: 14),
          TextField(controller: _name, decoration: const InputDecoration(hintText: 'Name, e.g. Gym')),
          const SizedBox(height: 10),
          if (_maps.available)
            TextField(
              controller: _search,
              decoration: const InputDecoration(prefixIcon: Icon(Icons.search), hintText: 'Search the address'),
              onSubmitted: (t) async {
                try {
                  final r = await _maps.search(t);
                  setState(() => _results = r);
                } catch (_) {
                  setState(() => _error = 'Search isn’t working. Check your internet.');
                }
              },
            ),
          for (final r in _results.take(4))
            ListTile(
              title: Text(r.name),
              subtitle: Text(r.address, maxLines: 1, overflow: TextOverflow.ellipsis),
              selected: _picked == r,
              onTap: () => setState(() => _picked = r),
            ),
          TextButton.icon(onPressed: _useHere, icon: const Icon(Icons.my_location), label: const Text('Use my current location')),
          if (_picked != null) Text('Selected: ${_picked!.address}', style: const TextStyle(color: AppColors.green)),
          if (_error != null) Text(_error!, style: const TextStyle(color: AppColors.red)),
          const SizedBox(height: 12),
          BusyButton(label: 'Save', onPressed: _save),
        ]),
      );
}

/// Report a problem → support ticket for the admin panel.
class ReportProblemScreen extends StatefulWidget {
  const ReportProblemScreen({super.key});

  @override
  State<ReportProblemScreen> createState() => _ReportProblemScreenState();
}

class _ReportProblemScreenState extends State<ReportProblemScreen> {
  String _category = 'otp';
  final _message = TextEditingController();
  String? _error;

  Future<void> _send() async {
    final text = _message.text.trim();
    if (text.length < 10 || text.length > 2000) return setState(() => _error = 'Write 10–2000 characters.');
    final state = AppScope.read(context);
    try {
      final info = await state.engine.deviceInfo();
      await state.api.reportProblem(_category, text,
          appVersion: info['appVersion'] as String?, deviceModel: info['model'] as String?);
      if (!mounted) return;
      showInfo(context, 'Thank you. Our team will reply within 1 working day.');
      Navigator.pop(context);
    } on ApiException catch (e) {
      setState(() => _error = e.message);
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: const Text('Report a problem')),
        body: ListView(padding: const EdgeInsets.all(20), children: [
          RadioGroup<String>(
            groupValue: _category,
            onChanged: (v) => setState(() => _category = v ?? _category),
            child: Column(children: [
              for (final (value, label) in [
                ('otp', 'OTP not received'),
                ('guardian_sms', 'Guardian didn’t get SMS'),
                ('app_stopped', 'App stopped working'),
                ('other', 'Other'),
              ])
                RadioListTile<String>(value: value, activeColor: AppColors.red, title: Text(label)),
            ]),
          ),
          const SizedBox(height: 10),
          TextField(
            controller: _message,
            maxLines: 6,
            maxLength: 2000,
            decoration: const InputDecoration(hintText: 'What happened?'),
          ),
          if (_error != null) Text(_error!, style: const TextStyle(color: AppColors.red)),
          const SizedBox(height: 10),
          BusyButton(label: 'Send', onPressed: _send),
        ]),
      );
}

/// Delete account: explain → type DELETE → new OTP → deleted → Welcome.
class DeleteAccountScreen extends StatefulWidget {
  const DeleteAccountScreen({super.key, this.otp});
  final PhoneOtp? otp;

  @override
  State<DeleteAccountScreen> createState() => _DeleteAccountScreenState();
}

class _DeleteAccountScreenState extends State<DeleteAccountScreen> {
  final _typed = TextEditingController();
  final _code = TextEditingController();
  late final PhoneOtp? _otp = widget.otp ?? (firebaseReady ? PhoneOtp() : null);
  bool _codeSent = false;
  String? _error;

  Future<void> _sendCode() async {
    final state = AppScope.read(context);
    if (state.engineState.sosId != null || state.engineState.journeyId != null) {
      return setState(() => _error = 'End your SOS or journey first.');
    }
    if (_otp == null) return setState(() => _error = 'Login is not set up in this build of the app.');
    try {
      final instant = await _otp.send(state.me!.phone);
      if (instant != null) return await _delete(instant);
      setState(() => _codeSent = true);
    } on OtpError catch (e) {
      setState(() => _error = e.message);
    }
  }

  Future<void> _verify() async {
    try {
      await _delete(await _otp!.verify(_code.text.trim()));
    } on OtpError catch (e) {
      setState(() => _error = e.message);
    }
  }

  Future<void> _delete(String idToken) async {
    final state = AppScope.read(context);
    try {
      await state.api.deleteAccount(idToken);
      if (!mounted) return;
      Navigator.of(context).popUntil((r) => r.isFirst);
      await state.accountDeleted();
    } on ApiException catch (e) {
      setState(() => _error = e.message);
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: const Text('Delete my account')),
        body: ListView(padding: const EdgeInsets.all(20), children: [
          const Text('What is deleted', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w700)),
          const SizedBox(height: 6),
          const Text('Your profile and photo, guardians, saved places, journeys, location history and audio recordings, and your login.'),
          const SizedBox(height: 14),
          const Text('What is kept', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w700)),
          const SizedBox(height: 6),
          const Text('Past SOS alerts are kept without your name or number, for safety reports.'),
          const SizedBox(height: 20),
          if (!_codeSent) ...[
            TextField(
              controller: _typed,
              onChanged: (_) => setState(() {}),
              decoration: const InputDecoration(hintText: 'Type DELETE to confirm'),
            ),
            const SizedBox(height: 14),
            BusyButton(label: 'Send OTP', color: AppColors.red, onPressed: _typed.text.trim() == 'DELETE' ? _sendCode : null),
          ] else ...[
            const Text('Enter the OTP we just sent to your phone.'),
            const SizedBox(height: 10),
            TextField(
              controller: _code,
              keyboardType: TextInputType.number,
              inputFormatters: [FilteringTextInputFormatter.digitsOnly, LengthLimitingTextInputFormatter(6)],
              decoration: const InputDecoration(hintText: '6-digit OTP'),
            ),
            const SizedBox(height: 14),
            BusyButton(label: 'Delete my account', color: AppColors.red, onPressed: _verify),
          ],
          if (_error != null) Padding(padding: const EdgeInsets.only(top: 10), child: Text(_error!, style: const TextStyle(color: AppColors.red))),
        ]),
      );
}
