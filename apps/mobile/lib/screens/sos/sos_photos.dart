import 'dart:async';
import 'dart:io';

import 'package:camera/camera.dart';
import 'package:flutter/material.dart';
import 'package:path_provider/path_provider.dart';
import 'package:permission_handler/permission_handler.dart';
import 'package:uuid/uuid.dart';

import '../../api/phase2_api.dart';
import '../../state/app_state.dart';
import '../../state/vault_session.dart';
import '../../theme.dart';
import '../../widgets/common.dart';
import '../../widgets/format.dart';

/// SOS photos are kept on this phone (private app storage) until they are saved into Mere Saboot.
Future<Directory> sosMediaDir(AppState state, String sosId) async {
  final dir = Directory('${(await getApplicationSupportDirectory()).path}/sos_media/${state.me?.id ?? 'none'}/$sosId');
  if (!await dir.exists()) await dir.create(recursive: true);
  return dir;
}

/// One photo taken during an SOS.
class _Shot {
  _Shot(this.id, this.camera, this.path, this.takenAt);
  final String id;
  final String camera; // back / front
  final String path;
  final DateTime takenAt;
  bool sent = false;
}

/// Photos during an SOS (feature 9): while the SOS screen is open the phone takes a back and a
/// front photo, and guardians see them on the live page. Up to the set number of pairs.
class SosPhotos extends StatefulWidget {
  const SosPhotos({super.key, required this.sosId, required this.active});
  final String sosId;
  final bool active;

  @override
  State<SosPhotos> createState() => _SosPhotosState();
}

class _SosPhotosState extends State<SosPhotos> {
  late final AppState _state = AppScope.read(context);
  final List<_Shot> _shots = [];
  bool _taking = false;
  bool _noCamera = false;
  Timer? _retry;

  int get _maxPairs => _state.me?.rule('sos.photo_pairs_max', 3) ?? 3;
  int get _pairs => _shots.where((s) => s.camera == 'back').length;

  @override
  void initState() {
    super.initState();
    _loadSaved().then((_) {
      if (widget.active && _shots.isEmpty) _takePair();
    });
    _retry = Timer.periodic(const Duration(seconds: 20), (_) => _sendPending());
  }

  @override
  void dispose() {
    _retry?.cancel();
    super.dispose();
  }

  Future<void> _loadSaved() async {
    final dir = await sosMediaDir(_state, widget.sosId);
    final files = dir.listSync().where((f) => f.path.endsWith('.jpg')).toList();
    for (final f in files) {
      final name = f.uri.pathSegments.last.replaceAll('.jpg', '');
      final parts = name.split('_'); // camera_id
      if (parts.length != 2) continue;
      final s = _Shot(parts[1], parts[0], f.path, (await f.stat()).modified);
      s.sent = await File('${f.path}.sent').exists();
      _shots.add(s);
    }
    _shots.sort((a, b) => a.takenAt.compareTo(b.takenAt));
    if (mounted) setState(() {});
  }

  Future<void> _takePair() async {
    if (_taking || _pairs >= _maxPairs) return;
    if (!await Permission.camera.request().isGranted) {
      if (mounted) setState(() => _noCamera = true);
      return;
    }
    setState(() {
      _taking = true;
      _noCamera = false;
    });
    try {
      final cams = await availableCameras();
      for (final dir in [CameraLensDirection.back, CameraLensDirection.front]) {
        final desc = cams.where((c) => c.lensDirection == dir).firstOrNull;
        if (desc == null) continue;
        final c = CameraController(desc, ResolutionPreset.medium, enableAudio: false, imageFormatGroup: ImageFormatGroup.jpeg);
        try {
          await c.initialize();
          final pic = await c.takePicture();
          final id = const Uuid().v4();
          final camera = dir == CameraLensDirection.back ? 'back' : 'front';
          final path = '${(await sosMediaDir(_state, widget.sosId)).path}/${camera}_$id.jpg';
          await File(pic.path).copy(path);
          unawaited(File(pic.path).delete().catchError((_) => File('')));
          final shot = _Shot(id, camera, path, DateTime.now());
          if (mounted) setState(() => _shots.add(shot));
          unawaited(_send(shot));
        } finally {
          await c.dispose();
        }
      }
    } catch (_) {
      if (mounted) setState(() => _noCamera = true);
    } finally {
      if (mounted) setState(() => _taking = false);
    }
  }

  Future<void> _send(_Shot s) async {
    if (s.sent) return;
    try {
      final size = await File(s.path).length();
      if (size > 1024 * 1024) return; // too big for the live page; it is still kept for the vault
      final link = await _state.api.sosPhotoUploadLink(widget.sosId, s.id, size);
      await _state.api.uploadFile(link, s.path);
      await _state.api.saveSosPhoto(widget.sosId, s.id, s.camera, s.takenAt);
      s.sent = true;
      await File('${s.path}.sent').writeAsString('1');
      if (mounted) setState(() {});
    } catch (_) {
      // Offline: tried again every 20 seconds while this screen is open.
    }
  }

  Future<void> _sendPending() async {
    for (final s in _shots.where((s) => !s.sent).toList()) {
      await _send(s);
    }
  }

  @override
  Widget build(BuildContext context) {
    if (!_state.feature('photos')) return const SizedBox.shrink();
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      const SectionLabel('Photos for your guardians'),
      AppCard(
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          if (_shots.isEmpty)
            Text(
              _noCamera ? 'The camera is not allowed or not available.' : (_taking ? 'Taking photos…' : 'No photos yet.'),
              style: const TextStyle(color: AppColors.muted),
            )
          else
            SizedBox(
              height: 84,
              child: ListView.separated(
                scrollDirection: Axis.horizontal,
                itemCount: _shots.length,
                separatorBuilder: (_, _) => const SizedBox(width: 8),
                itemBuilder: (_, i) => Stack(children: [
                  ClipRRect(
                    borderRadius: BorderRadius.circular(10),
                    child: Image.file(File(_shots[i].path), width: 84, height: 84, fit: BoxFit.cover, cacheWidth: 200),
                  ),
                  Positioned(
                    right: 4,
                    bottom: 4,
                    child: Icon(_shots[i].sent ? Icons.cloud_done : Icons.cloud_upload_outlined, size: 18, color: Colors.white),
                  ),
                ]),
              ),
            ),
          if (widget.active && _pairs < _maxPairs) ...[
            const SizedBox(height: 10),
            OutlinedButton.icon(
              key: const Key('sos-photos-again'),
              onPressed: _taking ? null : _takePair,
              icon: _taking
                  ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
                  : const Icon(Icons.photo_camera_outlined),
              label: Text(_shots.isEmpty ? 'Take photos' : 'Take photos again'),
            ),
          ],
        ]),
      ),
      const SizedBox(height: 8),
    ]);
  }
}

/// After an SOS: copies its photos and audio into Mere Saboot, in an "SOS" incident.
Future<void> saveSosToVault(BuildContext context, String sosId, DateTime startedAt) async {
  final state = AppScope.read(context);
  final vault = state.vault;
  try {
    final mode = await vault.state();
    if (mode == 'setup' || mode == 'restore') {
      if (context.mounted) showInfo(context, 'Set up Mere Saboot first (Menu → Mere Saboot).');
      return;
    }
    if (!vault.isOpen && !await vault.unlock()) return;
    // The SOS incident: made once, the server links it to this SOS.
    final incidents = await state.api.incidents();
    var incidentId = incidents.where((i) => i.sosId == sosId).firstOrNull?.id;
    if (incidentId == null) {
      incidentId = const Uuid().v4();
      final title = 'SOS on ${dateTime(startedAt)}';
      await state.api.saveIncident(incidentId, 'sos', await vault.lockJson(IncidentDetails(title: title, date: startedAt).toJson()));
    }
    var saved = 0;
    final dir = await sosMediaDir(state, sosId);
    for (final f in dir.listSync().where((f) => f.path.endsWith('.jpg')).toList()) {
      final camera = f.uri.pathSegments.last.startsWith('front') ? 'front' : 'back';
      final taken = (await f.stat()).modified;
      await vault.addFile(
        path: f.path,
        kind: 'photo',
        details: ItemDetails(note: 'SOS photo ($camera camera)', fileName: f.uri.pathSegments.last, mime: 'image/jpeg'),
        incidentId: incidentId,
        sosId: sosId,
        capturedAt: taken,
        deleteSource: true,
      );
      await File('${f.path}.sent').delete().catchError((_) => File(''));
      saved++;
    }
    for (final clip in await state.engine.listClips(sosId: sosId)) {
      final path = await state.engine.exportClip(clip.id);
      if (path == null) continue;
      await vault.addFile(
        path: path,
        kind: 'audio',
        details: ItemDetails(note: 'SOS recording (${clip.seconds} s)', fileName: 'SOS recording ${dateTime(clip.recordedAt)}.m4a', mime: 'audio/mp4'),
        incidentId: incidentId,
        sosId: sosId,
        capturedAt: clip.recordedAt,
        deleteSource: true,
      );
      saved++;
    }
    if (context.mounted) {
      showInfo(context, saved == 0 ? 'Nothing left on this phone to save for this SOS.' : 'Saved $saved item${saved == 1 ? '' : 's'} to Mere Saboot.');
    }
  } on VaultProblem catch (e) {
    if (context.mounted) showInfo(context, e.message);
  } catch (e) {
    if (context.mounted) showError(context, e);
  }
}
