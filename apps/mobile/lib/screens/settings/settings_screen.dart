import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:geolocator/geolocator.dart';
import 'package:permission_handler/permission_handler.dart' show openAppSettings;

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
import '../legal/legal_screen.dart';
import '../setup/safety_setup_screen.dart';
import '../sos/recordings_screen.dart';
import '../daily/daily_location_screen.dart';
import '../vault/vault_screen.dart';
import 'plans_screen.dart';
import 'sos_triggers_screen.dart';

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
        padding: const EdgeInsets.fromLTRB(20, 12, 20, 24),
        children: [
          const TabHeader('Settings'),
          if (me != null)
            Padding(
              padding: const EdgeInsets.only(bottom: 20),
              child: AppCard(
                onTap: () => open(const ProfileScreen(fromSettings: true)),
                padding: const EdgeInsets.fromLTRB(16, 16, 12, 16),
                child: Row(children: [
                  ProfileAvatar(name: me.name ?? '', photoUrl: me.photoUrl, localPhoto: state.localPhoto, size: 58),
                  const SizedBox(width: 14),
                  Expanded(
                    child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Text(me.name ?? '',
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w700)),
                      const SizedBox(height: 3),
                      Text(prettyPhone(me.phone), style: const TextStyle(color: AppColors.muted, fontSize: 14.5)),
                    ]),
                  ),
                  const Icon(Icons.chevron_right, color: Color(0xFF9CA3AF)),
                ]),
              ),
            ),
          MenuGroup(label: 'Safety', children: [
            MenuRow(icon: Icons.health_and_safety_outlined, title: 'Safety Setup', onTap: () => open(const SafetySetupScreen())),
            const MenuRow(icon: Icons.admin_panel_settings_outlined, title: 'App Permissions', onTap: openAppSettings),
            MenuRow(icon: Icons.headphones_outlined, title: 'My Recordings', onTap: () => open(const RecordingsScreen())),
            MenuRow(icon: Icons.people_outline, title: 'Guardians', onTap: () => open(const GuardiansScreen())),
            MenuRow(icon: Icons.location_on_outlined, title: 'Saved Places', onTap: () => open(const SavedPlacesScreen())),

          ]),
          MenuGroup(label: 'More protection', children: [
            MenuRow(icon: Icons.touch_app_outlined, title: 'SOS Triggers', onTap: () => open(const SosTriggersScreen())),
            if (state.feature('daily_location'))
              MenuRow(icon: Icons.my_location, title: 'Full-day Location', onTap: () => open(const DailyLocationScreen())),
            if (state.feature('vault')) MenuRow(icon: Icons.lock_outline, title: 'Mere Saboot', onTap: () => open(const VaultScreen())),
            if (state.feature('plans')) MenuRow(icon: Icons.workspace_premium_outlined, title: 'Plans', onTap: () => open(const PlansScreen())),
          ]),
          MenuGroup(label: 'About', children: [
            MenuRow(icon: Icons.shield_outlined, title: 'Privacy Policy', onTap: () => LegalScreen.open(context, LegalPage.privacy)),
            MenuRow(icon: Icons.description_outlined, title: 'Terms & Conditions', onTap: () => LegalScreen.open(context, LegalPage.terms)),
            MenuRow(icon: Icons.help_outline, title: 'Help & Support', onTap: () => open(const ReportProblemScreen())),
          ]),
          MenuGroup(label: 'Account', children: [
            MenuRow(
              icon: Icons.logout,
              title: 'Log Out',
              danger: true,
              onTap: () async {
                if (await confirm(context, 'Log out?', 'Protection stops on this phone until you log in again.', yes: 'Log out')) {
                  await state.logout();
                }
              },
            ),
            MenuRow(icon: Icons.delete_outline, title: 'Delete My Account', danger: true, onTap: () => open(const DeleteAccountScreen())),
          ]),
          const SizedBox(height: 4),
          // The app version and phone, so testers can tell which build each phone has.
          FutureBuilder<Map<dynamic, dynamic>>(
            future: state.engine.deviceInfo().catchError((_) => <dynamic, dynamic>{}),
            builder: (_, snap) {
              final i = snap.data;
              if (i == null || i['appVersion'] == null) return const SizedBox.shrink();
              return Padding(
                padding: const EdgeInsets.only(bottom: 10),
                child: Text('Version ${i['appVersion']} · Android ${i['androidVersion'] ?? '?'} · ${i['model'] ?? ''}',
                    textAlign: TextAlign.center, style: const TextStyle(color: AppColors.muted, fontSize: 12)),
              );
            },
          ),
          const Padding(
            padding: EdgeInsets.symmetric(horizontal: 12),
            child: Text(AppConfig.notMonitoring,
                textAlign: TextAlign.center, style: TextStyle(color: AppColors.muted, fontSize: 13, height: 1.4)),
          ),
        ],
      ),
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
  String? _loadError;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() => _loadError = null);
    try {
      final p = await AppScope.read(context).api.places();
      if (mounted) setState(() => _places = p);
    } on ApiException catch (e) {
      if (mounted) setState(() => _loadError = e.message);
    } catch (e) {
      if (mounted) setState(() => _loadError = 'Could not load your places. Please try again.');
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
          ? Center(
              child: _loadError == null
                  ? const CircularProgressIndicator()
                  : Padding(
                      padding: const EdgeInsets.all(24),
                      child: Column(mainAxisSize: MainAxisSize.min, children: [
                        Text(_loadError!, textAlign: TextAlign.center, style: const TextStyle(color: AppColors.red)),
                        const SizedBox(height: 12),
                        OutlinedButton(key: const Key('places-retry'), onPressed: _load, child: const Text('Try again')),
                      ]),
                    ),
            )
          : ListView(padding: const EdgeInsets.fromLTRB(20, 8, 20, 24), children: [
              _PlaceRow(icon: Icons.home, title: 'Home', place: home, onEdit: () => _add('home'), onDelete: home == null ? null : () => _delete(home)),
              _PlaceRow(icon: Icons.work, title: 'Work', place: work, onEdit: () => _add('work'), onDelete: work == null ? null : () => _delete(work)),
              for (final p in places.where((p) => p.label == 'other'))
                _PlaceRow(icon: Icons.place, title: p.name, place: p, onEdit: null, onDelete: () => _delete(p)),
              const SizedBox(height: 6),
              OutlinedButton.icon(
                onPressed: () => _add('other'),
                style: OutlinedButton.styleFrom(foregroundColor: AppColors.red),
                icon: const Icon(Icons.add),
                label: const Text('Add a place'),
              ),
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
        padding: const EdgeInsets.only(bottom: 10),
        child: AppCard(
          onTap: onEdit,
          padding: const EdgeInsets.fromLTRB(14, 12, 6, 12),
          child: Row(children: [
            IconTile(icon),
            const SizedBox(width: 14),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(title, style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 16)),
                // The address (a place saved without one shows just its name, never twice).
                if (place == null || place!.address != null || place!.name != title) ...[
                  const SizedBox(height: 2),
                  Text(place?.address ?? place?.name ?? 'Not set',
                      style: const TextStyle(color: AppColors.muted, fontSize: 14),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis),
                ],
              ]),
            ),
            if (onDelete != null)
              IconButton(onPressed: onDelete, color: AppColors.muted, icon: const Icon(Icons.delete_outline))
            else
              const SizedBox(width: 48, child: Icon(Icons.chevron_right, color: Color(0xFF9CA3AF))),
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
  bool _searching = false;
  bool _searched = false;
  bool _locating = false;

  /// Search-as-you-type: waits for a short pause in typing, then searches.
  Timer? _typing;
  static const _typingPause = Duration(milliseconds: 500);
  static const _minLetters = 3;

  /// Only the newest search may show its results (an older, slower one is ignored).
  int _searchNo = 0;

  /// Where the phone last was (no prompt, no waiting): places near it are listed first.
  Position? _near;

  @override
  void initState() {
    super.initState();
    _lastKnownPlace();
  }

  Future<void> _lastKnownPlace() async {
    try {
      final p = await Geolocator.checkPermission();
      if (p != LocationPermission.always && p != LocationPermission.whileInUse) return;
      _near = await Geolocator.getLastKnownPosition();
    } catch (_) {
      // Searched across India instead.
    }
  }

  /// A result was tapped: it is the chosen place (the keyboard closes so "Save" is in view).
  void _pick(PlaceResult r) {
    FocusScope.of(context).unfocus();
    setState(() {
      _picked = r;
      _error = null;
    });
  }

  @override
  void dispose() {
    _typing?.cancel();
    _name.dispose();
    _search.dispose();
    super.dispose();
  }

  void _onTyping(String text) {
    _typing?.cancel();
    if (text.trim().length < _minLetters) {
      _searchNo++; // a search still running for the old text is not shown
      setState(() {
        _results = const [];
        _searched = false;
        _searching = false;
      });
      return;
    }
    _typing = Timer(_typingPause, () => _find(fromTyping: true));
  }

  /// [fromTyping]: started by typing (the keyboard stays open); otherwise the arrow or Search key.
  Future<void> _find({bool fromTyping = false}) async {
    _typing?.cancel();
    final text = _search.text.trim();
    if (text.length < 2) return setState(() => _error = 'Type at least 2 letters of the place or address.');
    if (!fromTyping) FocusScope.of(context).unfocus();
    final no = ++_searchNo;
    setState(() {
      _searching = true;
      _error = null;
    });
    try {
      final r = await _maps.search(text, nearLat: _near?.latitude, nearLng: _near?.longitude);
      if (mounted && no == _searchNo) setState(() => _results = r);
    } catch (_) {
      if (mounted && no == _searchNo) setState(() => _error = 'Search isn’t working. Check your internet.');
    } finally {
      if (mounted && no == _searchNo) {
        setState(() {
          _searching = false;
          _searched = true;
        });
      }
    }
  }

  Future<void> _useHere() async {
    setState(() {
      _locating = true;
      _error = null;
    });
    try {
      if (!await Geolocator.isLocationServiceEnabled()) {
        return setState(() => _error = 'Location is turned off on this phone. Turn it on and try again.');
      }
      var permission = await Geolocator.checkPermission();
      if (permission == LocationPermission.denied) permission = await Geolocator.requestPermission();
      if (permission == LocationPermission.denied || permission == LocationPermission.deniedForever) {
        return setState(() => _error = 'Location is not allowed. Allow it in Settings → App Permissions.');
      }
      final pos = await Geolocator.getCurrentPosition(
        locationSettings: const LocationSettings(accuracy: LocationAccuracy.high, timeLimit: Duration(seconds: 25)),
      );
      final address = await _maps.addressAt(pos.latitude, pos.longitude);
      if (mounted) {
        setState(() => _picked = PlaceResult(_name.text, address ?? 'My current location', pos.latitude, pos.longitude));
      }
    } catch (_) {
      if (mounted) setState(() => _error = 'Could not get your location. Go near a window or outside and try again.');
    } finally {
      if (mounted) setState(() => _locating = false);
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
        child: SingleChildScrollView(
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            const Text('Save a place', style: TextStyle(fontSize: 22, fontWeight: FontWeight.w800)),
            const SizedBox(height: 14),
            TextField(controller: _name, decoration: const InputDecoration(hintText: 'Name, e.g. Gym')),
            const SizedBox(height: 10),
            if (_maps.canSearch)
              TextField(
                key: const Key('place-search'),
                controller: _search,
                textInputAction: TextInputAction.search,
                // One icon: places are listed while typing, so there is no arrow button (the
                // keyboard's Search key still searches at once).
                decoration: InputDecoration(
                  prefixIcon: const Icon(Icons.search),
                  hintText: 'Search area, place or address',
                  suffixIcon: _searching
                      ? const Padding(padding: EdgeInsets.all(14), child: CircularProgressIndicator(strokeWidth: 2))
                      : null,
                ),
                onChanged: _onTyping,
                onSubmitted: (_) => _find(),
              ),
            if (_searched && _results.isEmpty && !_searching)
              const Padding(
                padding: EdgeInsets.only(top: 8),
                child: Text('No places found. Try the area and city, e.g. “Sector 18, Noida”, or use your current location when you are there.',
                    style: TextStyle(color: AppColors.muted)),
              ),
            if (_results.isNotEmpty && _picked == null)
              const Padding(
                padding: EdgeInsets.only(top: 8, left: 4),
                child: Text('Tap the right place:', style: TextStyle(color: AppColors.muted, fontSize: 13)),
              ),
            for (final r in _results.take(5))
              ListTile(
                key: ValueKey('place-${r.lat},${r.lng}'),
                leading: Icon(_picked == r ? Icons.check_circle : Icons.place_outlined,
                    color: _picked == r ? AppColors.green : AppColors.muted),
                title: Text(r.name),
                subtitle: Text(r.address, maxLines: 2, overflow: TextOverflow.ellipsis),
                selected: _picked == r,
                selectedColor: AppColors.green,
                onTap: () => _pick(r),
              ),
            TextButton.icon(
              onPressed: _locating ? null : _useHere,
              icon: _locating
                  ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
                  : const Icon(Icons.my_location),
              label: const Text('Use my current location'),
            ),
            if (_picked != null)
              Text('Selected: ${_picked!.address}',
                  key: const Key('place-selected'), style: const TextStyle(color: AppColors.green, fontWeight: FontWeight.w600)),
            if (_error != null) Text(_error!, style: const TextStyle(color: AppColors.red)),
            const SizedBox(height: 12),
            BusyButton(label: 'Save', onPressed: _save),
          ]),
        ),
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
        body: ListView(padding: const EdgeInsets.fromLTRB(20, 8, 20, 24), children: [
          const SectionLabel('What is the problem?'),
          AppCard(
            padding: const EdgeInsets.symmetric(vertical: 4),
            child: RadioGroup<String>(
              groupValue: _category,
              onChanged: (v) => setState(() => _category = v ?? _category),
              child: Column(children: [
                for (final (value, label) in [
                  ('otp', 'OTP not received'),
                  ('guardian_sms', 'Guardian didn’t get SMS'),
                  ('app_stopped', 'App stopped working'),
                  ('other', 'Other'),
                ])
                  RadioListTile<String>(
                    value: value,
                    activeColor: AppColors.red,
                    contentPadding: const EdgeInsets.symmetric(horizontal: 8),
                    title: Text(label, style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w500)),
                  ),
              ]),
            ),
          ),
          const SizedBox(height: 20),
          const SectionLabel('Tell us more'),
          TextField(
            controller: _message,
            maxLines: 6,
            maxLength: 2000,
            decoration: const InputDecoration(hintText: 'What happened?'),
          ),
          if (_error != null) Text(_error!, style: const TextStyle(color: AppColors.red)),
          const SizedBox(height: 12),
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
        body: ListView(padding: const EdgeInsets.fromLTRB(20, 8, 20, 24), children: [
          const AppCard(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              _DeleteFact(
                icon: Icons.delete_outline,
                color: AppColors.red,
                title: 'What is deleted',
                text: 'Your profile and photo, guardians, saved places, journeys, location history and audio recordings, and your login.',
              ),
              Divider(height: 28, color: Color(0xFFF0ECE7)),
              _DeleteFact(
                icon: Icons.inventory_2_outlined,
                color: AppColors.muted,
                title: 'What is kept',
                text: 'Past SOS alerts are kept without your name or number, for safety reports.',
              ),
            ]),
          ),
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

class _DeleteFact extends StatelessWidget {
  const _DeleteFact({required this.icon, required this.color, required this.title, required this.text});
  final IconData icon;
  final Color color;
  final String title;
  final String text;

  @override
  Widget build(BuildContext context) => Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        IconTile(icon, color: color),
        const SizedBox(width: 14),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(title, style: const TextStyle(fontSize: 16.5, fontWeight: FontWeight.w700)),
            const SizedBox(height: 4),
            Text(text, style: const TextStyle(color: AppColors.muted, height: 1.4)),
          ]),
        ),
      ]);
}
