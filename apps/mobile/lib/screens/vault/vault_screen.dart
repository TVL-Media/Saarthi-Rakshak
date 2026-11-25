import 'dart:async';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:geolocator/geolocator.dart';
import 'package:image_picker/image_picker.dart';

import '../../api/api_client.dart';
import '../../api/maps_service.dart';
import '../../api/phase2_api.dart';
import '../../state/app_state.dart';
import '../../state/vault_session.dart';
import '../../theme.dart';
import '../../widgets/common.dart';
import 'evidence_screens.dart';
import 'vault_setup_screen.dart';

/// Shown on the vault screens and in onboarding (feature 21).
const vaultTagline = 'Mere Saboot Mere Paas Hai';

const incidentKinds = {
  'blackmail': 'Blackmail',
  'harassment': 'Harassment',
  'physical': 'Physical harassment',
  'sos': 'SOS',
  'other': 'Other',
};

IconData evidenceIcon(String kind) => switch (kind) {
      'audio' => Icons.mic_none,
      'video' => Icons.videocam_outlined,
      'photo' => Icons.photo_outlined,
      'detail' => Icons.alternate_email,
      'report' => Icons.picture_as_pdf_outlined,
      _ => Icons.insert_drive_file_outlined,
    };

String evidenceLabel(String kind) => switch (kind) {
      'audio' => 'Audio recording',
      'video' => 'Video',
      'photo' => 'Photo',
      'detail' => 'Details',
      'report' => 'Report',
      _ => 'File',
    };

String sizeText(int bytes) {
  if (bytes >= 1024 * 1024 * 1024) return '${(bytes / (1024 * 1024 * 1024)).toStringAsFixed(1)} GB';
  if (bytes >= 1024 * 1024) return '${(bytes / (1024 * 1024)).toStringAsFixed(1)} MB';
  return '${(bytes / 1024).ceil()} KB';
}

/// Where the user is now, for a new item ("Sector 62, Noida"); null if not allowed / not known.
/// Never waits long: the phone's last known position (instant), a fresh one only if there is
/// none (at most 4 s), and the place name at most 3 s. Saving evidence must not wait for GPS.
Future<({double lat, double lng, String? place})?> currentPlace() async {
  final cached = _lastPlace;
  if (cached != null && DateTime.now().difference(cached.$1) < const Duration(minutes: 2)) return cached.$2;
  try {
    final perm = await Geolocator.checkPermission();
    if (perm == LocationPermission.denied || perm == LocationPermission.deniedForever) return null;
    final pos = await Geolocator.getLastKnownPosition() ??
        await Geolocator.getCurrentPosition(locationSettings: const LocationSettings(timeLimit: Duration(seconds: 4)));
    final area = await MapsService()
        .areaName(pos.latitude, pos.longitude)
        .timeout(const Duration(seconds: 3), onTimeout: () => null)
        .catchError((_) => null);
    final place = (lat: pos.latitude, lng: pos.longitude, place: area);
    _lastPlace = (DateTime.now(), place);
    return place;
  } catch (_) {
    return null;
  }
}

(DateTime, ({double lat, double lng, String? place}))? _lastPlace;

/// "Mere Saboot": the evidence vault (features 12–21). Opens with fingerprint, face or phone PIN
/// every time and locks again after 2 minutes away. Only the user can open what is inside.
class VaultScreen extends StatefulWidget {
  const VaultScreen({super.key});

  @override
  State<VaultScreen> createState() => _VaultScreenState();
}

class _VaultScreenState extends State<VaultScreen> with WidgetsBindingObserver {
  late final AppState _state = AppScope.read(context);
  VaultSession get _vault => _state.vault;
  String? _mode; // locked / setup / restore / open
  String? _error;
  bool _busy = false;
  List<EvidenceItem> _items = const [];
  List<Incident> _incidents = const [];
  List<PendingUpload> _pending = const [];
  VaultUsage? _usage;
  final Map<String, IncidentDetails> _incidentDetails = {};

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _vault.addListener(_onVault);
    _start();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _vault.removeListener(_onVault);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState s) {
    if (s == AppLifecycleState.resumed) _vault.resumed();
  }

  void _onVault() {
    if (!mounted) return;
    if (!_vault.isOpen && _mode == 'open') {
      setState(() => _mode = 'locked');
    } else if (_vault.isOpen) {
      _load();
    }
  }

  Future<void> _start() async {
    setState(() {
      _error = null;
      _mode = null;
    });
    try {
      final mode = await _vault.state();
      if (!mounted) return;
      setState(() => _mode = mode);
      if (mode == 'open') await _load();
      // 'locked': the unlock view asks for the password (or the fingerprint, if it is on).
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } catch (e) {
      if (mounted) setState(() => _error = 'Could not open the vault. Please try again.');
    }
  }

  /// Locked with the Lock button (not by time away).
  bool _lockedByUser = false;

  Future<void> _opened() async {
    if (!mounted) return;
    _lockedByUser = false;
    setState(() => _mode = 'open');
    await _load();
  }

  bool _loading = false;
  bool _loadAgain = false;

  /// Reloads the lists; calls that arrive while loading are merged into one more load.
  Future<void> _load() async {
    if (_loading) {
      _loadAgain = true;
      return;
    }
    _loading = true;
    try {
      do {
        _loadAgain = false;
        await _loadOnce();
      } while (_loadAgain && mounted);
    } finally {
      _loading = false;
    }
  }

  Future<void> _loadOnce() async {
    try {
      // The three lists at the same time (one wait, not three).
      final lists = await Future.wait<Object>([_state.api.evidence(), _state.api.incidents(), _state.api.vaultUsage()]);
      final items = lists[0] as List<EvidenceItem>;
      final incidents = lists[1] as List<Incident>;
      final usage = lists[2] as VaultUsage;
      final pending = await _vault.pending();
      for (final i in incidents) {
        if (!_incidentDetails.containsKey(i.id)) _incidentDetails[i.id] = await _vault.incidentDetails(i);
      }
      if (!mounted) return;
      setState(() {
        _items = items;
        _incidents = incidents;
        _usage = usage;
        _pending = pending;
        _error = null;
      });
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } catch (_) {
      if (mounted && _vault.isOpen) setState(() => _error = 'Could not load your evidence. Pull down to try again.');
    }
  }

  /// A file still on this phone: try the upload again, or view it from its encrypted copy.
  Future<void> _waitingItem(PendingUpload p) async {
    final choice = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Saved on this phone'),
        content: Text(_vault.uploadErrors[p.id] ??
            'This file is encrypted and kept on your phone until it reaches the server. You can still open it here.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, 'view'), child: const Text('Open')),
          TextButton(onPressed: () => Navigator.pop(ctx, 'retry'), child: const Text('Try upload again')),
        ],
      ),
    );
    if (!mounted || choice == null) return;
    if (choice == 'view') {
      final item = await _vault.pendingItem(p.id);
      if (!mounted) return;
      if (item == null) {
        await _load();
        return;
      }
      await _open(EvidenceItemScreen(item: item, incidents: _incidents, incidentDetails: _incidentDetails));
      return;
    }
    await _vault.retryUploads();
    await _load();
    if (!mounted) return;
    final err = _vault.uploadErrors[p.id];
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(err ?? 'Uploaded.')));
  }

  Future<void> _open(Widget screen) async {
    _vault.touch();
    await Navigator.push(context, MaterialPageRoute(builder: (_) => screen));
    if (mounted && _vault.isOpen) await _load();
  }

  Future<void> _addPicked({required String path, required String kind, String? name, String? mime}) async {
    final place = await currentPlace();
    if (!mounted) return;
    final note = await askNote(context, title: 'Add a note', hint: 'What does this show? (optional)');
    if (note == null || !mounted) return;
    final incidentId = await pickIncident(context, _incidents, _incidentDetails);
    if (!mounted) return;
    setState(() => _busy = true);
    try {
      await _vault.addFile(
        path: path,
        kind: kind,
        details: ItemDetails(note: note, fileName: name, mime: mime, lat: place?.lat, lng: place?.lng, place: place?.place),
        incidentId: incidentId,
      );
      if (mounted) showInfo(context, 'Saved to Mere Saboot.');
    } on VaultProblem catch (e) {
      if (mounted) showInfo(context, e.message);
    } catch (e) {
      if (mounted) showError(context, e);
    } finally {
      if (mounted) setState(() => _busy = false);
      await _load();
    }
  }

  Future<void> _camera(bool video) async {
    _vault.touch();
    final free = await _state.engine.freeBytes().catchError((_) => 1 << 30);
    if (free < 200 * 1024 * 1024) {
      if (mounted) showInfo(context, 'Free up space to record.');
      return;
    }
    unawaited(currentPlace()); // looked up while the camera is open
    final picker = ImagePicker();
    final file = video
        ? await picker.pickVideo(source: ImageSource.camera, maxDuration: const Duration(minutes: 10))
        : await picker.pickImage(source: ImageSource.camera, imageQuality: 92);
    if (file == null || !mounted) return;
    await _addPicked(path: file.path, kind: video ? 'video' : 'photo', name: file.name, mime: video ? 'video/mp4' : 'image/jpeg');
  }

  Future<void> _files() async {
    _vault.touch();
    final res = await FilePicker.pickFiles(
      type: FileType.custom,
      allowedExtensions: const ['jpg', 'jpeg', 'png', 'webp', 'heic', 'mp4', 'mov', '3gp', 'mkv', 'm4a', 'mp3', 'aac', 'wav', 'ogg', 'opus', 'amr', 'pdf'],
    );
    if (!mounted) return;
    for (final f in res) {
      if (f.path == null) continue;
      if ((await f.length() ?? 0) > 200 * 1024 * 1024) {
        if (!mounted) return;
        showInfo(context, 'This file is too large (max 200 MB).');
        continue;
      }
      await _addPicked(path: f.path!, kind: kindForName(f.name), name: f.name, mime: mimeForName(f.name));
      if (!mounted) return;
    }
  }

  @override
  Widget build(BuildContext context) {
    final mode = _mode;
    return Scaffold(
      appBar: AppBar(
        title: const Text('Mere Saboot'),
        actions: [
          if (mode == 'open')
            IconButton(
              tooltip: 'Lock',
              icon: const Icon(Icons.lock_outline),
              // Stays on this page: it changes to the password screen (leaving the page at once
              // looked like a crash).
              onPressed: () {
                _lockedByUser = true;
                _vault.lock();
                showInfo(context, 'Mere Saboot is locked.');
              },
            ),
        ],
      ),
      body: AnimatedSwitcher(
        duration: const Duration(milliseconds: 250),
        child: KeyedSubtree(
          key: ValueKey(mode),
          child: switch (mode) {
            null => _error != null ? _errorView() : const Center(child: CircularProgressIndicator()),
            'setup' => VaultSetupView(onDone: _start),
            'startOver' => VaultSetupView(startOver: true, onDone: _start),
            'locked' => VaultUnlockView(
                // Just locked with the button: do not pop the fingerprint prompt up again at once.
                autoFingerprint: !_lockedByUser,
                onOpened: _opened,
                onStartOver: () => setState(() => _mode = 'startOver'),
              ),
            _ => _openView(),
          },
        ),
      ),
    );
  }

  Widget _errorView() => Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            Text(_error!, textAlign: TextAlign.center, style: const TextStyle(color: AppColors.red)),
            const SizedBox(height: 12),
            OutlinedButton(onPressed: _start, child: const Text('Try again')),
          ]),
        ),
      );

  Widget _openView() {
    final loose = _items.where((i) => i.incidentId == null && !i.hidden).toList();
    final hidden = _items.where((i) => i.hidden).length;
    final usage = _usage;
    return RefreshIndicator(
      onRefresh: _load,
      child: ListView(padding: const EdgeInsets.fromLTRB(20, 8, 20, 32), children: [
        const VaultHero(compact: true),
        const SizedBox(height: 16),
        if (usage != null) ...[
          AppCard(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Row(children: [
                const Text('Storage', style: TextStyle(fontWeight: FontWeight.w700)),
                const SizedBox(width: 12),
                Expanded(
                  child: Text('${sizeText(usage.usedBytes)} of ${sizeText(usage.limitBytes)}',
                      textAlign: TextAlign.end, style: const TextStyle(color: AppColors.muted)),
                ),
              ]),
              const SizedBox(height: 10),
              ClipRRect(
                borderRadius: BorderRadius.circular(4),
                child: LinearProgressIndicator(
                  value: usage.limitBytes == 0 ? 0 : (usage.usedBytes / usage.limitBytes).clamp(0, 1),
                  minHeight: 6,
                  backgroundColor: const Color(0xFFF0ECE7),
                  color: AppColors.red,
                ),
              ),
            ]),
          ),
          const SizedBox(height: 16),
        ],
        if (_error != null) ...[
          NoticeBox(text: _error!, icon: Icons.error_outline, color: AppColors.red, background: AppColors.redSoft),
          const SizedBox(height: 16),
        ],
        if (_vault.uploadProblem != null) ...[
          NoticeBox(text: _vault.uploadProblem!, icon: Icons.cloud_off_outlined),
          const SizedBox(height: 16),
        ],
        const SectionLabel('Add evidence'),
        GridView.count(
          crossAxisCount: 3,
          shrinkWrap: true,
          physics: const NeverScrollableScrollPhysics(),
          mainAxisSpacing: 10,
          crossAxisSpacing: 10,
          childAspectRatio: 1.05,
          children: [
            _Action(Icons.mic_none, 'Record audio', _busy ? null : () => _open(const AudioRecorderScreen())),
            _Action(Icons.videocam_outlined, 'Record video', _busy ? null : () => _camera(true)),
            _Action(Icons.photo_camera_outlined, 'Take photo', _busy ? null : () => _camera(false)),
            _Action(Icons.upload_file_outlined, 'Add files', _busy ? null : _files),
            _Action(Icons.alternate_email, 'Add details', _busy ? null : () => _open(AddDetailScreen(incidents: _incidents, incidentDetails: _incidentDetails))),
            _Action(Icons.create_new_folder_outlined, 'New incident', _busy ? null : () => _open(const IncidentFormScreen())),
          ],
        ),
        if (_busy) const Padding(padding: EdgeInsets.only(top: 12), child: LinearProgressIndicator(color: AppColors.red)),
        if (_pending.isNotEmpty) ...[
          const SizedBox(height: 20),
          const SectionLabel('Waiting to upload'),
          AppCard(
            padding: EdgeInsets.zero,
            child: Column(children: [
              for (final p in _pending)
                MenuRow(
                  icon: evidenceIcon(p.kind),
                  title: evidenceLabel(p.kind),
                  subtitle: _vault.isUploading(p.id)
                      ? 'Saved on this phone · uploading…'
                      : _vault.uploadErrors[p.id] != null
                          ? 'Saved on this phone · ${_vault.uploadErrors[p.id]}'
                          : 'Saved on this phone · uploads when online',
                  trailing: _vault.isUploading(p.id)
                      ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2))
                      : const Icon(Icons.cloud_upload_outlined, color: AppColors.muted),
                  onTap: () => _waitingItem(p),
                ),
            ]),
          ),
        ],
        const SizedBox(height: 20),
        const SectionLabel('Incidents'),
        if (_incidents.isEmpty)
          const AppCard(
            child: EmptyState(icon: Icons.folder_open_outlined, text: 'No incidents yet. Group items into an incident to make a report.'),
          )
        else
          AppCard(
            padding: EdgeInsets.zero,
            child: Column(children: [
              for (final (n, i) in _incidents.indexed) ...[
                if (n > 0) const Divider(height: 1, thickness: 1, indent: 68, color: Color(0xFFF0ECE7)),
                MenuRow(
                  icon: i.kind == 'sos' ? Icons.sos : Icons.folder_outlined,
                  accent: true,
                  title: _incidentDetails[i.id]?.title ?? 'Incident',
                  subtitle: '${incidentKinds[i.kind]} · ${i.itemsCount} item${i.itemsCount == 1 ? '' : 's'}',
                  onTap: () => _open(IncidentScreen(incident: i, details: _incidentDetails[i.id]!, all: _items, incidents: _incidents, incidentDetails: _incidentDetails)),
                ),
              ],
            ]),
          ),
        const SizedBox(height: 20),
        const SectionLabel('Other items'),
        if (loose.isEmpty)
          AppCard(
            child: EmptyState(
              icon: Icons.lock_outline,
              text: _items.isEmpty ? '$vaultTagline. Record, photograph or add files. Only you can open them.' : 'Everything is in an incident.',
            ),
          )
        else
          AppCard(
            padding: EdgeInsets.zero,
            child: Column(children: [
              for (final (n, i) in loose.indexed) ...[
                if (n > 0) const Divider(height: 1, thickness: 1, indent: 68, color: Color(0xFFF0ECE7)),
                EvidenceRow(item: i, onTap: () => _open(EvidenceItemScreen(item: i, incidents: _incidents, incidentDetails: _incidentDetails))),
              ],
            ]),
          ),
        const SizedBox(height: 20),
        MenuGroup(label: 'Privacy', children: [
          MenuRow(icon: Icons.history, title: 'Access history', subtitle: 'Every view, export and share', onTap: () => _open(const AccessHistoryScreen())),
          if (hidden > 0)
            MenuRow(
              icon: Icons.visibility_off_outlined,
              title: 'Hidden items',
              subtitle: '$hidden hidden',
              onTap: () => _open(HiddenItemsScreen(items: _items.where((i) => i.hidden).toList(), incidents: _incidents, incidentDetails: _incidentDetails)),
            ),
          MenuRow(icon: Icons.key_outlined, title: 'Password', subtitle: 'Change it, or open with fingerprint', onTap: () => _open(const VaultPasswordScreen())),
        ]),
      ]),
    );
  }
}

class _Action extends StatelessWidget {
  const _Action(this.icon, this.label, this.onTap);
  final IconData icon;
  final String label;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) => AppCard(
        onTap: onTap,
        padding: const EdgeInsets.all(8),
        child: Column(mainAxisAlignment: MainAxisAlignment.center, children: [
          IconTile(icon, size: 40),
          const SizedBox(height: 8),
          Text(label, textAlign: TextAlign.center, maxLines: 2, style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600, height: 1.2)),
        ]),
      );
}

/// The vault's header: tagline and what the vault is.
class VaultHero extends StatelessWidget {
  const VaultHero({super.key, this.compact = false});
  final bool compact;

  @override
  Widget build(BuildContext context) => Container(
        padding: EdgeInsets.all(compact ? 16 : 22),
        decoration: BoxDecoration(color: AppColors.night, borderRadius: BorderRadius.circular(20)),
        child: Row(children: [
          IconTile(Icons.shield_outlined, color: Colors.white, background: Colors.white.withValues(alpha: 0.12), size: compact ? 44 : 56),
          const SizedBox(width: 14),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(vaultTagline, style: TextStyle(color: Colors.white, fontSize: compact ? 17 : 20, fontWeight: FontWeight.w800)),
              const SizedBox(height: 4),
              const Text('Your evidence, encrypted on your phone. Only you can open it.',
                  style: TextStyle(color: Color(0xFFB8BEC6), fontSize: 13.5, height: 1.35)),
            ]),
          ),
        ]),
      );
}

String kindForName(String name) {
  final ext = name.toLowerCase().split('.').last;
  if (const {'jpg', 'jpeg', 'png', 'webp', 'heic'}.contains(ext)) return 'photo';
  if (const {'mp4', 'mov', '3gp', 'mkv'}.contains(ext)) return 'video';
  if (const {'m4a', 'mp3', 'aac', 'wav', 'ogg', 'opus', 'amr'}.contains(ext)) return 'audio';
  return 'file';
}

String mimeForName(String name) {
  final ext = name.toLowerCase().split('.').last;
  return switch (ext) {
    'jpg' || 'jpeg' => 'image/jpeg',
    'png' => 'image/png',
    'webp' => 'image/webp',
    'heic' => 'image/heic',
    'mp4' => 'video/mp4',
    'mov' => 'video/quicktime',
    '3gp' => 'video/3gpp',
    'mkv' => 'video/x-matroska',
    'm4a' || 'aac' => 'audio/mp4',
    'mp3' => 'audio/mpeg',
    'wav' => 'audio/wav',
    'ogg' || 'opus' => 'audio/ogg',
    'amr' => 'audio/amr',
    'pdf' => 'application/pdf',
    _ => 'application/octet-stream',
  };
}

/// A short note (null = cancelled).
Future<String?> askNote(BuildContext context, {required String title, String hint = '', String initial = ''}) {
  final c = TextEditingController(text: initial);
  return showDialog<String>(
    context: context,
    builder: (ctx) => AlertDialog(
      title: Text(title),
      content: TextField(controller: c, maxLines: 4, minLines: 2, maxLength: 2000, decoration: InputDecoration(hintText: hint)),
      actions: [
        TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')),
        FilledButton(
          style: FilledButton.styleFrom(minimumSize: const Size(0, 44)),
          onPressed: () => Navigator.pop(ctx, c.text.trim()),
          child: const Text('Save'),
        ),
      ],
    ),
  );
}

/// Picks an incident for a new item (null = none).
Future<String?> pickIncident(BuildContext context, List<Incident> incidents, Map<String, IncidentDetails> details) async {
  if (incidents.isEmpty) return null;
  return showModalBottomSheet<String?>(
    context: context,
    backgroundColor: AppColors.cream,
    builder: (ctx) => SafeArea(
      child: ListView(shrinkWrap: true, padding: const EdgeInsets.fromLTRB(20, 16, 20, 16), children: [
        const Text('Add to an incident?', style: TextStyle(fontSize: 20, fontWeight: FontWeight.w800)),
        const SizedBox(height: 12),
        AppCard(
          padding: EdgeInsets.zero,
          child: Column(children: [
            MenuRow(icon: Icons.inbox_outlined, title: 'No incident', onTap: () => Navigator.pop(ctx)),
            for (final i in incidents)
              MenuRow(
                icon: Icons.folder_outlined,
                accent: true,
                title: details[i.id]?.title ?? 'Incident',
                subtitle: incidentKinds[i.kind],
                onTap: () => Navigator.pop(ctx, i.id),
              ),
          ]),
        ),
      ]),
    ),
  );
}
