import 'dart:io';

import 'package:flutter/material.dart';

import '../../api/phase2_api.dart';
import '../../state/app_state.dart';
import '../../state/vault_session.dart';
import '../../theme.dart';
import '../../widgets/common.dart';
import 'vault_screen.dart';

/// A file shared to Sarthi Rakshak from another app (copied into the app's cache by Android code).
class SharedFile {
  SharedFile({required this.path, required this.name, required this.mime});
  final String path;
  final String name;
  final String mime;

  factory SharedFile.fromMap(Map<dynamic, dynamic> m) => SharedFile(
        path: '${m['path'] ?? ''}',
        name: '${m['name'] ?? 'file'}',
        mime: '${m['mime'] ?? 'application/octet-stream'}',
      );

  String get kind {
    if (mime.startsWith('image/')) return 'photo';
    if (mime.startsWith('video/')) return 'video';
    if (mime.startsWith('audio/')) return 'audio';
    return kindForName(name);
  }
}

/// Android "Share → Sarthi Rakshak": saves screenshots, chats or recordings into Mere Saboot.
class ShareImportScreen extends StatefulWidget {
  const ShareImportScreen({super.key, required this.files});
  final List<SharedFile> files;

  @override
  State<ShareImportScreen> createState() => _ShareImportScreenState();
}

class _ShareImportScreenState extends State<ShareImportScreen> {
  late final AppState _state = AppScope.read(context);
  final _note = TextEditingController();
  List<Incident> _incidents = const [];
  final Map<String, IncidentDetails> _details = {};
  String? _incident;
  String? _error;
  bool _ready = false;

  @override
  void initState() {
    super.initState();
    _open();
  }

  @override
  void dispose() {
    _note.dispose();
    _cleanup();
    super.dispose();
  }

  void _cleanup() {
    for (final f in widget.files) {
      try {
        File(f.path).deleteSync();
      } catch (_) {}
    }
  }

  Future<void> _open() async {
    try {
      final mode = await _state.vault.state();
      if (mode == 'locked' && !await _state.vault.unlock()) {
        if (mounted) setState(() => _error = 'Open Mere Saboot with your fingerprint, face or PIN to save these files.');
        return;
      }
      if (mode == 'setup' || mode == 'restore') {
        if (mounted) setState(() => _error = 'Set up Mere Saboot first (Menu → Mere Saboot), then share again.');
        return;
      }
      _incidents = await _state.api.incidents();
      for (final i in _incidents) {
        _details[i.id] = await _state.vault.incidentDetails(i);
      }
      if (mounted) setState(() => _ready = true);
    } on VaultProblem catch (e) {
      if (mounted) setState(() => _error = e.message);
    } catch (_) {
      if (mounted) setState(() => _error = 'Could not open Mere Saboot. Please try again.');
    }
  }

  Future<void> _save() async {
    final place = await currentPlace();
    var saved = 0;
    for (final f in widget.files) {
      if (!await File(f.path).exists()) continue;
      if (await File(f.path).length() > 200 * 1024 * 1024) {
        if (mounted) showInfo(context, '${f.name} is too large (max 200 MB).');
        continue;
      }
      try {
        await _state.vault.addFile(
          path: f.path,
          kind: f.kind,
          details: ItemDetails(note: _note.text.trim(), fileName: f.name, mime: f.mime, lat: place?.lat, lng: place?.lng, place: place?.place),
          incidentId: _incident,
          deleteSource: true,
        );
        saved++;
      } on VaultProblem catch (e) {
        if (mounted) setState(() => _error = e.message);
        return;
      }
    }
    if (!mounted) return;
    showInfo(context, saved == 1 ? 'Saved to Mere Saboot.' : '$saved files saved to Mere Saboot.');
    Navigator.pop(context);
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: const Text('Save to Mere Saboot')),
        body: ListView(padding: const EdgeInsets.fromLTRB(20, 8, 20, 32), children: [
          const VaultHero(compact: true),
          const SizedBox(height: 16),
          MenuGroup(label: 'Files', children: [
            for (final f in widget.files) MenuRow(icon: evidenceIcon(f.kind), title: f.name, subtitle: evidenceLabel(f.kind), trailing: const SizedBox.shrink()),
          ]),
          if (_error != null) ...[
            NoticeBox(text: _error!, icon: Icons.error_outline, color: AppColors.red, background: AppColors.redSoft),
            const SizedBox(height: 12),
            OutlinedButton(onPressed: _open, child: const Text('Try again')),
          ],
          if (_ready) ...[
            TextField(controller: _note, maxLines: 3, maxLength: 2000, decoration: const InputDecoration(labelText: 'Note (optional)')),
            if (_incidents.isNotEmpty)
              DropdownButtonFormField<String?>(
                initialValue: _incident,
                decoration: const InputDecoration(labelText: 'Incident'),
                items: [
                  const DropdownMenuItem(value: null, child: Text('No incident')),
                  for (final i in _incidents)
                    DropdownMenuItem(value: i.id, child: Text(_details[i.id]?.title ?? 'Incident', overflow: TextOverflow.ellipsis)),
                ],
                onChanged: (v) => setState(() => _incident = v),
              ),
            const SizedBox(height: 20),
            BusyButton(label: 'Encrypt and save', icon: Icons.lock_outline, onPressed: _save),
          ] else if (_error == null)
            const Padding(padding: EdgeInsets.all(24), child: Center(child: CircularProgressIndicator())),
        ]),
      );
}
