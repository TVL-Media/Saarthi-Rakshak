import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:path_provider/path_provider.dart';
import 'package:record/record.dart';
import 'package:share_plus/share_plus.dart';
import 'package:uuid/uuid.dart';

import '../../api/api_client.dart';
import '../../api/phase2_api.dart';
import '../../state/app_state.dart';
import '../../state/vault_session.dart';
import '../../theme.dart';
import '../../widgets/common.dart';
import '../../widgets/format.dart';
import 'report_pdf.dart';
import 'vault_screen.dart';

/// A list row for one evidence item (details are decrypted on the phone).
class EvidenceRow extends StatefulWidget {
  const EvidenceRow({super.key, required this.item, this.onTap});
  final EvidenceItem item;
  final VoidCallback? onTap;

  @override
  State<EvidenceRow> createState() => _EvidenceRowState();
}

class _EvidenceRowState extends State<EvidenceRow> {
  ItemDetails? _d;

  @override
  void initState() {
    super.initState();
    AppScope.read(context).vault.details(widget.item).then((d) {
      if (mounted) setState(() => _d = d);
    }).catchError((_) {});
  }

  @override
  Widget build(BuildContext context) {
    final i = widget.item;
    final d = _d;
    final title = i.kind == 'detail' ? (d?.value ?? 'Details') : (d?.fileName ?? evidenceLabel(i.kind));
    final sub = [dateTime(i.capturedAt), if (i.hasFile) sizeText(i.sizeBytes), if (d != null && d.note.isNotEmpty) d.note].join(' · ');
    return MenuRow(icon: evidenceIcon(i.kind), title: title, subtitle: sub, onTap: widget.onTap);
  }
}

// ---- Item detail ------------------------------------------------------------------------------

class EvidenceItemScreen extends StatefulWidget {
  const EvidenceItemScreen({super.key, required this.item, required this.incidents, required this.incidentDetails});
  final EvidenceItem item;
  final List<Incident> incidents;
  final Map<String, IncidentDetails> incidentDetails;

  @override
  State<EvidenceItemScreen> createState() => _EvidenceItemScreenState();
}

class _EvidenceItemScreenState extends State<EvidenceItemScreen> {
  late final AppState _state = AppScope.read(context);
  VaultSession get _vault => _state.vault;
  late EvidenceItem _item = widget.item;
  ItemDetails? _d;
  String? _opened; // decrypted file path (photos are shown here)
  bool _opening = false;

  @override
  void initState() {
    super.initState();
    _vault.details(_item).then((d) {
      if (mounted) setState(() => _d = d);
    }).catchError((_) {});
  }

  Future<void> _open() async {
    setState(() => _opening = true);
    try {
      final path = await _vault.openFile(_item);
      if (!mounted) return;
      if (_item.kind == 'photo') {
        setState(() => _opened = path);
      } else {
        await _state.engine.openFile(path, VaultSession.mimeOf(_item.kind, _d ?? ItemDetails()));
      }
    } on ApiException catch (e) {
      if (mounted) showInfo(context, e.message);
    } catch (e) {
      if (mounted) showInfo(context, 'Could not open this file. It may not be uploaded yet.');
    } finally {
      if (mounted) setState(() => _opening = false);
    }
  }

  Future<void> _share() async {
    if (!await _vault.confirm('Confirm to share this evidence')) return;
    try {
      final path = await _vault.openFile(_item);
      await _vault.log('shared', itemId: _item.id, incidentId: _item.incidentId);
      await SharePlus.instance.share(ShareParams(files: [XFile(path, mimeType: VaultSession.mimeOf(_item.kind, _d ?? ItemDetails()))]));
    } on VaultProblem catch (e) {
      if (mounted) showInfo(context, e.message);
    } catch (e) {
      if (mounted) showError(context, e);
    }
  }

  Future<void> _save() async {
    if (!await _vault.confirm('Confirm to save a copy to Downloads')) return;
    try {
      final path = await _vault.openFile(_item);
      final d = _d ?? ItemDetails();
      final name = d.fileName ?? path.split('/').last;
      final ok = await _state.engine.saveToDownloads(path, name, VaultSession.mimeOf(_item.kind, d));
      await _vault.log('exported', itemId: _item.id, incidentId: _item.incidentId);
      if (mounted) showInfo(context, ok ? 'Saved to Downloads (not encrypted).' : 'Could not save the copy.');
    } catch (e) {
      if (mounted) showError(context, e);
    }
  }

  Future<void> _editNote() async {
    final d = _d ?? ItemDetails();
    final note = await askNote(context, title: 'Note', initial: d.note);
    if (note == null) return;
    try {
      final next = ItemDetails(note: note, fileName: d.fileName, mime: d.mime, lat: d.lat, lng: d.lng, place: d.place, detailType: d.detailType, value: d.value);
      _item = await _state.api.updateEvidence(_item.id, {'lockedDetails': await _vault.lockJson(next.toJson())});
      await _vault.log('edited', itemId: _item.id, incidentId: _item.incidentId);
      _vault.details(_item).ignore();
      if (mounted) setState(() => _d = next);
    } catch (e) {
      if (mounted) showError(context, e);
    }
  }

  Future<void> _move() async {
    final id = await pickIncident(context, widget.incidents, widget.incidentDetails);
    if (id == _item.incidentId) return;
    try {
      _item = await _state.api.updateEvidence(_item.id, {'incidentId': id});
      await _vault.log('edited', itemId: _item.id, incidentId: id);
      if (mounted) setState(() {});
    } catch (e) {
      if (mounted) showError(context, e);
    }
  }

  Future<void> _hide() async {
    try {
      _item = await _state.api.updateEvidence(_item.id, {'hidden': !_item.hidden});
      await _vault.log(_item.hidden ? 'hidden' : 'unhidden', itemId: _item.id, incidentId: _item.incidentId);
      if (mounted) {
        setState(() {});
        showInfo(context, _item.hidden ? 'Hidden. Find it under Hidden items.' : 'Shown again.');
      }
    } catch (e) {
      if (mounted) showError(context, e);
    }
  }

  Future<void> _delete() async {
    if (_item.locked) {
      showInfo(context, 'This item is protected from deletion until ${dateTime(_item.deleteLockedUntil)}.');
      return;
    }
    if (!await confirm(context, 'Delete this evidence?', 'It will be deleted for good. This cannot be undone.', yes: 'Delete', danger: true)) return;
    if (!await _vault.confirm('Confirm to delete evidence')) return;
    try {
      await _state.api.deleteEvidence(_item.id);
      await _vault.log('deleted', itemId: _item.id, incidentId: _item.incidentId);
      if (mounted) Navigator.pop(context);
    } catch (e) {
      if (mounted) showError(context, e);
    }
  }

  @override
  Widget build(BuildContext context) {
    final d = _d;
    final i = _item;
    final incident = i.incidentId == null ? null : widget.incidentDetails[i.incidentId];
    return Scaffold(
      appBar: AppBar(title: Text(evidenceLabel(i.kind))),
      body: ListView(padding: const EdgeInsets.fromLTRB(20, 8, 20, 32), children: [
        if (_opened != null)
          ClipRRect(borderRadius: BorderRadius.circular(16), child: Image.file(File(_opened!), fit: BoxFit.contain))
        else
          AppCard(
            child: Column(children: [
              const SizedBox(height: 12),
              IconTile(evidenceIcon(i.kind), size: 64),
              const SizedBox(height: 12),
              Text(i.kind == 'detail' ? (d?.value ?? '') : (d?.fileName ?? evidenceLabel(i.kind)),
                  textAlign: TextAlign.center, style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w700)),
              if (i.kind == 'detail' && d?.detailType != null)
                Padding(padding: const EdgeInsets.only(top: 4), child: Text(detailTypes[d!.detailType] ?? '', style: const TextStyle(color: AppColors.muted))),
              const SizedBox(height: 16),
              if (i.hasFile)
                SizedBox(
                  width: double.infinity,
                  child: FilledButton.icon(
                    onPressed: _opening ? null : _open,
                    icon: _opening
                        ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                        : Icon(i.kind == 'audio' || i.kind == 'video' ? Icons.play_arrow : Icons.open_in_new),
                    label: Text(i.kind == 'audio' || i.kind == 'video' ? 'Play' : 'Open'),
                  ),
                ),
            ]),
          ),
        const SizedBox(height: 16),
        MenuGroup(label: 'Details', children: [
          _InfoRow(Icons.schedule, 'Captured', dateTime(i.capturedAt)),
          _InfoRow(Icons.cloud_done_outlined, 'Received by server', dateTime(i.receivedAt)),
          if (d?.place != null || d?.lat != null)
            _InfoRow(Icons.place_outlined, 'Place', d!.place ?? '${d.lat!.toStringAsFixed(5)}, ${d.lng!.toStringAsFixed(5)}'),
          if (i.hasFile) _InfoRow(Icons.sd_storage_outlined, 'Size', sizeText(i.sizeBytes)),
          MenuRow(icon: Icons.notes, title: 'Note', subtitle: (d?.note.isEmpty ?? true) ? 'Add a note' : d!.note, onTap: _editNote),
          MenuRow(icon: Icons.folder_outlined, title: 'Incident', subtitle: incident?.title ?? 'None', onTap: _move),
        ]),
        MenuGroup(label: 'Fingerprint (SHA-256)', children: [
          MenuRow(
            icon: Icons.verified_outlined,
            title: 'Tamper check',
            subtitle: i.sha256,
            trailing: const Icon(Icons.copy, size: 20, color: AppColors.muted),
            onTap: () {
              Clipboard.setData(ClipboardData(text: i.sha256));
              showInfo(context, 'Fingerprint copied.');
            },
          ),
        ]),
        MenuGroup(children: [
          if (i.hasFile) MenuRow(icon: Icons.ios_share, title: 'Share', subtitle: 'Asks for your fingerprint first', onTap: _share),
          if (i.hasFile) MenuRow(icon: Icons.download_outlined, title: 'Save a copy to Downloads', onTap: _save),
          MenuRow(icon: i.hidden ? Icons.visibility_outlined : Icons.visibility_off_outlined, title: i.hidden ? 'Show again' : 'Hide', onTap: _hide),
          MenuRow(
            icon: Icons.delete_outline,
            title: 'Delete',
            subtitle: i.locked ? 'Protected until ${dateTime(i.deleteLockedUntil)}' : null,
            danger: true,
            onTap: _delete,
          ),
        ]),
      ]),
    );
  }
}

class _InfoRow extends StatelessWidget {
  const _InfoRow(this.icon, this.title, this.value);
  final IconData icon;
  final String title;
  final String value;

  @override
  Widget build(BuildContext context) => MenuRow(icon: icon, title: title, subtitle: value, trailing: const SizedBox.shrink());
}

// ---- Audio recorder ---------------------------------------------------------------------------

class AudioRecorderScreen extends StatefulWidget {
  const AudioRecorderScreen({super.key, this.incidentId});
  final String? incidentId;

  @override
  State<AudioRecorderScreen> createState() => _AudioRecorderScreenState();
}

class _AudioRecorderScreenState extends State<AudioRecorderScreen> {
  late final AppState _state = AppScope.read(context);
  final _rec = AudioRecorder();
  Timer? _timer;
  Duration _elapsed = Duration.zero;
  String? _path;
  bool _recording = false;
  bool _saving = false;
  Future<({double lat, double lng, String? place})?>? _place;

  @override
  void dispose() {
    _timer?.cancel();
    _rec.dispose();
    super.dispose();
  }

  Future<void> _start() async {
    if (!await _rec.hasPermission()) {
      if (mounted) showInfo(context, 'Allow the microphone to record.');
      return;
    }
    final free = await _state.engine.freeBytes().catchError((_) => 1 << 30);
    if (free < 100 * 1024 * 1024) {
      if (mounted) showInfo(context, 'Free up space to record.');
      return;
    }
    _place = currentPlace(); // looked up while recording, ready when it stops
    final dir = await getTemporaryDirectory();
    _path = '${dir.path}/rec_${DateTime.now().millisecondsSinceEpoch}.m4a';
    await _rec.start(const RecordConfig(encoder: AudioEncoder.aacLc, bitRate: 64000, sampleRate: 22050, numChannels: 1), path: _path!);
    setState(() {
      _recording = true;
      _elapsed = Duration.zero;
    });
    _timer = Timer.periodic(const Duration(seconds: 1), (_) {
      if (mounted) setState(() => _elapsed += const Duration(seconds: 1));
      _state.vault.touch();
    });
  }

  Future<void> _stop() async {
    _timer?.cancel();
    final path = await _rec.stop() ?? _path;
    setState(() {
      _recording = false;
      _saving = true;
    });
    try {
      if (path == null) return;
      final place = await (_place ?? currentPlace());
      await _state.vault.addFile(
        path: path,
        kind: 'audio',
        details: ItemDetails(fileName: 'Recording ${dateTime(DateTime.now())}.m4a', mime: 'audio/mp4', lat: place?.lat, lng: place?.lng, place: place?.place),
        incidentId: widget.incidentId,
        deleteSource: true,
      );
      if (mounted) {
        showInfo(context, 'Recording saved to Mere Saboot.');
        Navigator.pop(context);
      }
    } on VaultProblem catch (e) {
      if (mounted) showInfo(context, e.message);
    } catch (e) {
      if (mounted) showError(context, e);
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  String get _clock {
    final m = _elapsed.inMinutes.toString().padLeft(2, '0');
    final s = (_elapsed.inSeconds % 60).toString().padLeft(2, '0');
    return '$m:$s';
  }

  @override
  Widget build(BuildContext context) => PopScope(
        canPop: !_recording && !_saving,
        child: Scaffold(
          appBar: AppBar(title: const Text('Record audio')),
          body: Padding(
            padding: const EdgeInsets.all(24),
            child: Column(children: [
              const Spacer(),
              Text(_clock, style: const TextStyle(fontSize: 56, fontWeight: FontWeight.w800, fontFeatures: [FontFeature.tabularFigures()])),
              const SizedBox(height: 8),
              Text(
                _saving ? 'Encrypting and saving…' : (_recording ? 'Recording. Keep the app open.' : 'Tap to start recording'),
                style: const TextStyle(color: AppColors.muted, fontSize: 16),
              ),
              const Spacer(),
              SizedBox(
                width: 96,
                height: 96,
                child: FilledButton(
                  key: const Key('record-button'),
                  style: FilledButton.styleFrom(shape: const CircleBorder(), padding: EdgeInsets.zero, backgroundColor: AppColors.red),
                  onPressed: _saving ? null : (_recording ? _stop : _start),
                  child: _saving
                      ? const CircularProgressIndicator(color: Colors.white)
                      : Icon(_recording ? Icons.stop_rounded : Icons.mic, size: 44),
                ),
              ),
              const SizedBox(height: 32),
              const NoticeBox(
                text: 'The recording is encrypted on this phone before it is uploaded. Only you can play it.',
                icon: Icons.lock_outline,
                color: AppColors.green,
                background: AppColors.greenSoft,
              ),
            ]),
          ),
        ),
      );
}

// ---- Typed details ----------------------------------------------------------------------------

const detailTypes = {
  'phone': 'Phone number',
  'email': 'Email',
  'url': 'Link',
  'profile': 'Social media profile',
  'other': 'Other',
};

class AddDetailScreen extends StatefulWidget {
  const AddDetailScreen({super.key, required this.incidents, required this.incidentDetails, this.incidentId});
  final List<Incident> incidents;
  final Map<String, IncidentDetails> incidentDetails;
  final String? incidentId;

  @override
  State<AddDetailScreen> createState() => _AddDetailScreenState();
}

class _AddDetailScreenState extends State<AddDetailScreen> {
  String _type = 'phone';
  final _value = TextEditingController();
  final _note = TextEditingController();
  late String? _incident = widget.incidentId;
  String? _error;

  @override
  void dispose() {
    _value.dispose();
    _note.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    final v = _value.text.trim();
    if (v.isEmpty) {
      setState(() => _error = 'Enter the ${detailTypes[_type]!.toLowerCase()}.');
      return;
    }
    try {
      await AppScope.read(context).vault.addDetail(type: _type, value: v, note: _note.text.trim(), incidentId: _incident);
      if (mounted) {
        showInfo(context, 'Saved to Mere Saboot.');
        Navigator.pop(context);
      }
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } on VaultProblem catch (e) {
      if (mounted) setState(() => _error = e.message);
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: const Text('Add details')),
        body: ListView(padding: const EdgeInsets.fromLTRB(20, 8, 20, 32), children: [
          const Text('Save the number, email, link or profile of the person troubling you.',
              style: TextStyle(color: AppColors.muted, fontSize: 15, height: 1.4)),
          const SizedBox(height: 16),
          Wrap(spacing: 8, runSpacing: 8, children: [
            for (final e in detailTypes.entries)
              PillChoice(label: e.value, selected: _type == e.key, onSelected: (_) => setState(() => _type = e.key)),
          ]),
          const SizedBox(height: 16),
          TextField(
            controller: _value,
            keyboardType: switch (_type) {
              'phone' => TextInputType.phone,
              'email' => TextInputType.emailAddress,
              'url' || 'profile' => TextInputType.url,
              _ => TextInputType.text,
            },
            maxLength: 300,
            decoration: InputDecoration(labelText: detailTypes[_type]),
          ),
          TextField(controller: _note, maxLines: 3, maxLength: 2000, decoration: const InputDecoration(labelText: 'Note (optional)')),
          if (widget.incidents.isNotEmpty) ...[
            const SizedBox(height: 8),
            DropdownButtonFormField<String?>(
              initialValue: _incident,
              decoration: const InputDecoration(labelText: 'Incident'),
              items: [
                const DropdownMenuItem(value: null, child: Text('No incident')),
                for (final i in widget.incidents)
                  DropdownMenuItem(value: i.id, child: Text(widget.incidentDetails[i.id]?.title ?? 'Incident', overflow: TextOverflow.ellipsis)),
              ],
              onChanged: (v) => setState(() => _incident = v),
            ),
          ],
          if (_error != null) Padding(padding: const EdgeInsets.only(top: 12), child: Text(_error!, style: const TextStyle(color: AppColors.red))),
          const SizedBox(height: 20),
          BusyButton(label: 'Save', onPressed: _save),
        ]),
      );
}

// ---- Incidents --------------------------------------------------------------------------------

class IncidentFormScreen extends StatefulWidget {
  const IncidentFormScreen({super.key, this.incident, this.details});
  final Incident? incident;
  final IncidentDetails? details;

  @override
  State<IncidentFormScreen> createState() => _IncidentFormScreenState();
}

class _IncidentFormScreenState extends State<IncidentFormScreen> {
  late final _title = TextEditingController(text: widget.details?.title ?? '');
  late final _desc = TextEditingController(text: widget.details?.description ?? '');
  late String _kind = widget.incident?.kind ?? 'harassment';
  late DateTime _date = widget.details?.date ?? DateTime.now();
  String? _error;

  @override
  void dispose() {
    _title.dispose();
    _desc.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    if (_title.text.trim().length < 2) {
      setState(() => _error = 'Give the incident a short title.');
      return;
    }
    final state = AppScope.read(context);
    try {
      final locked = await state.vault.lockJson(IncidentDetails(title: _title.text.trim(), date: _date, description: _desc.text.trim()).toJson());
      if (widget.incident == null) {
        await state.api.saveIncident(const Uuid().v4(), _kind, locked);
      } else {
        await state.api.updateIncident(widget.incident!.id, {'kind': _kind, 'lockedDetails': locked});
      }
      if (mounted) Navigator.pop(context, true);
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } on VaultProblem catch (e) {
      if (mounted) setState(() => _error = e.message);
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: Text(widget.incident == null ? 'New incident' : 'Edit incident')),
        body: ListView(padding: const EdgeInsets.fromLTRB(20, 8, 20, 32), children: [
          TextField(controller: _title, maxLength: 80, decoration: const InputDecoration(labelText: 'Title')),
          const SizedBox(height: 4),
          const SectionLabel('Type'),
          Wrap(spacing: 8, runSpacing: 8, children: [
            for (final e in incidentKinds.entries)
              if (e.key != 'sos' || widget.incident?.kind == 'sos')
                PillChoice(label: e.value, selected: _kind == e.key, onSelected: (_) => setState(() => _kind = e.key)),
          ]),
          const SizedBox(height: 16),
          AppCard(
            padding: EdgeInsets.zero,
            child: MenuRow(
              icon: Icons.event_outlined,
              title: 'When it happened',
              subtitle: dateTime(_date),
              onTap: () async {
                final d = await showDatePicker(context: context, initialDate: _date, firstDate: DateTime(2000), lastDate: DateTime.now());
                if (d == null || !context.mounted) return;
                final t = await showTimePicker(context: context, initialTime: TimeOfDay.fromDateTime(_date));
                setState(() => _date = DateTime(d.year, d.month, d.day, t?.hour ?? _date.hour, t?.minute ?? _date.minute));
              },
            ),
          ),
          const SizedBox(height: 16),
          TextField(controller: _desc, minLines: 4, maxLines: 8, maxLength: 4000, decoration: const InputDecoration(labelText: 'What happened (optional)')),
          if (_error != null) Padding(padding: const EdgeInsets.only(top: 12), child: Text(_error!, style: const TextStyle(color: AppColors.red))),
          const SizedBox(height: 20),
          BusyButton(label: 'Save', onPressed: _save),
          const SizedBox(height: 12),
          const NoticeBox(text: 'The title and description are encrypted on this phone. Only you can read them.', icon: Icons.lock_outline, color: AppColors.green, background: AppColors.greenSoft),
        ]),
      );
}

class IncidentScreen extends StatefulWidget {
  const IncidentScreen({super.key, required this.incident, required this.details, required this.all, required this.incidents, required this.incidentDetails});
  final Incident incident;
  final IncidentDetails details;
  final List<EvidenceItem> all;
  final List<Incident> incidents;
  final Map<String, IncidentDetails> incidentDetails;

  @override
  State<IncidentScreen> createState() => _IncidentScreenState();
}

class _IncidentScreenState extends State<IncidentScreen> {
  late final AppState _state = AppScope.read(context);
  late List<EvidenceItem> _items = widget.all.where((i) => i.incidentId == widget.incident.id).toList();
  late IncidentDetails _details = widget.details;
  late Incident _incident = widget.incident;

  Future<void> _reload() async {
    try {
      final all = await _state.api.evidence();
      final incidents = await _state.api.incidents();
      final inc = incidents.where((i) => i.id == _incident.id).firstOrNull;
      if (inc != null) {
        _incident = inc;
        _details = await _state.vault.incidentDetails(inc);
        widget.incidentDetails[inc.id] = _details;
      }
      if (mounted) setState(() => _items = all.where((i) => i.incidentId == _incident.id).toList());
    } catch (_) {}
  }

  Future<void> _go(Widget w) async {
    await Navigator.push(context, MaterialPageRoute(builder: (_) => w));
    await _reload();
  }

  /// Builds the incident report (PDF), keeps a copy in the vault, then shares or saves it.
  Future<void> _report() async {
    final vault = _state.vault;
    if (!await vault.confirm('Confirm to make a report')) return;
    if (!mounted) return;
    final choice = await showModalBottomSheet<String>(
      context: context,
      backgroundColor: AppColors.cream,
      builder: (ctx) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(20, 16, 20, 16),
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            const Text('Incident report', style: TextStyle(fontSize: 20, fontWeight: FontWeight.w800)),
            const SizedBox(height: 6),
            const Text('A PDF with the date, place, time and fingerprint of every item. The files themselves are not inside.',
                style: TextStyle(color: AppColors.muted, height: 1.4)),
            const SizedBox(height: 12),
            MenuGroup(children: [
              MenuRow(icon: Icons.ios_share, title: 'Share', subtitle: 'Police, lawyer, family', onTap: () => Navigator.pop(ctx, 'share')),
              MenuRow(icon: Icons.download_outlined, title: 'Save to Downloads', onTap: () => Navigator.pop(ctx, 'save')),
            ]),
          ]),
        ),
      ),
    );
    if (choice == null) return;
    try {
      final rows = <ReportRow>[];
      for (final i in _items) {
        final d = await vault.details(i);
        rows.add(ReportRow(i.kind == 'detail' ? '${detailTypes[d.detailType] ?? 'Detail'}: ${d.value ?? ''}' : (d.fileName ?? evidenceLabel(i.kind)), [
          'Type: ${evidenceLabel(i.kind)}',
          'Captured: ${dateTime(i.capturedAt)}',
          'Received by server: ${dateTime(i.receivedAt)}',
          if (d.place != null) 'Place: ${d.place}',
          if (d.lat != null) 'Location: ${d.lat!.toStringAsFixed(5)}, ${d.lng!.toStringAsFixed(5)}',
          if (i.hasFile) 'Size: ${sizeText(i.sizeBytes)}',
          'SHA-256: ${i.sha256}',
          if (d.note.isNotEmpty) 'Note: ${d.note}',
        ]));
      }
      final now = DateTime.now();
      final path = await buildReportPdf(
        fileName: 'Incident report ${now.millisecondsSinceEpoch}.pdf',
        title: _details.title,
        intro: [
          'Type: ${incidentKinds[_incident.kind]}',
          'When: ${dateTime(_details.date)}',
          if (_details.description.isNotEmpty) 'What happened: ${_details.description}',
          'Items: ${_items.length}',
          'Report made: ${dateTime(now)} by ${_state.me?.name ?? 'the user'}',
        ],
        rows: rows,
        footer: const [
          'Each item was encrypted on the user\'s phone when it was saved. "Received by server" is the time the server got it and cannot be changed.',
          'The SHA-256 fingerprint of an original file proves it has not been changed since it was saved.',
        ],
      );
      await vault.addFile(
        path: path,
        kind: 'report',
        details: ItemDetails(fileName: 'Report – ${_details.title}.pdf', mime: 'application/pdf'),
        incidentId: _incident.id,
      ).catchError((_) => '');
      await vault.log('report', incidentId: _incident.id);
      if (choice == 'share') {
        await vault.log('shared', incidentId: _incident.id);
        await SharePlus.instance.share(ShareParams(files: [XFile(path, mimeType: 'application/pdf')], subject: _details.title));
      } else {
        final ok = await _state.engine.saveToDownloads(path, 'Sarthi Rakshak report ${now.millisecondsSinceEpoch}.pdf', 'application/pdf');
        await vault.log('exported', incidentId: _incident.id);
        if (mounted) showInfo(context, ok ? 'Report saved to Downloads.' : 'Could not save the report.');
      }
      await _reload();
    } on VaultProblem catch (e) {
      if (mounted) showInfo(context, e.message);
    } catch (e) {
      if (mounted) showError(context, e);
    }
  }

  @override
  Widget build(BuildContext context) {
    final visible = _items.where((i) => !i.hidden).toList();
    return Scaffold(
      appBar: AppBar(
        title: Text(_details.title, overflow: TextOverflow.ellipsis),
        actions: [
          IconButton(
            tooltip: 'Edit',
            icon: const Icon(Icons.edit_outlined),
            onPressed: () => _go(IncidentFormScreen(incident: _incident, details: _details)),
          ),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: _reload,
        child: ListView(padding: const EdgeInsets.fromLTRB(20, 8, 20, 32), children: [
          AppCard(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Row(children: [
                StatusPill(incidentKinds[_incident.kind] ?? '', color: AppColors.red),
                const SizedBox(width: 10),
                Expanded(
                  child: Text(dateTime(_details.date), textAlign: TextAlign.end, style: const TextStyle(color: AppColors.muted)),
                ),
              ]),
              if (_details.description.isNotEmpty) ...[
                const SizedBox(height: 12),
                Text(_details.description, style: const TextStyle(fontSize: 15, height: 1.45)),
              ],
            ]),
          ),
          const SizedBox(height: 16),
          SizedBox(
            width: double.infinity,
            child: FilledButton.icon(
              onPressed: _items.isEmpty ? null : _report,
              icon: const Icon(Icons.picture_as_pdf_outlined),
              label: const Text('Make a report'),
            ),
          ),
          const SizedBox(height: 10),
          Row(children: [
            Expanded(
              child: OutlinedButton.icon(
                onPressed: () => _go(AudioRecorderScreen(incidentId: _incident.id)),
                icon: const Icon(Icons.mic_none),
                label: const Text('Record'),
              ),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: OutlinedButton.icon(
                onPressed: () => _go(AddDetailScreen(incidents: widget.incidents, incidentDetails: widget.incidentDetails, incidentId: _incident.id)),
                icon: const Icon(Icons.alternate_email),
                label: const Text('Details'),
              ),
            ),
          ]),
          const SizedBox(height: 20),
          SectionLabel('Items (${visible.length})'),
          if (visible.isEmpty)
            const AppCard(child: EmptyState(icon: Icons.inbox_outlined, text: 'No items yet. Add items from Mere Saboot and choose this incident.'))
          else
            AppCard(
              padding: EdgeInsets.zero,
              child: Column(children: [
                for (final (n, i) in visible.indexed) ...[
                  if (n > 0) const Divider(height: 1, thickness: 1, indent: 68, color: Color(0xFFF0ECE7)),
                  EvidenceRow(
                    item: i,
                    onTap: () => _go(EvidenceItemScreen(item: i, incidents: widget.incidents, incidentDetails: widget.incidentDetails)),
                  ),
                ],
              ]),
            ),
        ]),
      ),
    );
  }
}

// ---- Hidden items / access history ------------------------------------------------------------

class HiddenItemsScreen extends StatelessWidget {
  const HiddenItemsScreen({super.key, required this.items, required this.incidents, required this.incidentDetails});
  final List<EvidenceItem> items;
  final List<Incident> incidents;
  final Map<String, IncidentDetails> incidentDetails;

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: const Text('Hidden items')),
        body: ListView(padding: const EdgeInsets.fromLTRB(20, 8, 20, 32), children: [
          MenuGroup(children: [
            for (final i in items)
              EvidenceRow(
                item: i,
                onTap: () async {
                  await Navigator.push(context,
                      MaterialPageRoute(builder: (_) => EvidenceItemScreen(item: i, incidents: incidents, incidentDetails: incidentDetails)));
                  if (context.mounted) Navigator.pop(context);
                },
              ),
          ]),
        ]),
      );
}

const _actionLabels = {
  'created': 'Added',
  'viewed': 'Opened',
  'exported': 'Saved a copy',
  'shared': 'Shared',
  'edited': 'Edited',
  'hidden': 'Hidden',
  'unhidden': 'Shown again',
  'deleted': 'Deleted',
  'report': 'Made a report',
};

class AccessHistoryScreen extends StatefulWidget {
  const AccessHistoryScreen({super.key});

  @override
  State<AccessHistoryScreen> createState() => _AccessHistoryScreenState();
}

class _AccessHistoryScreenState extends State<AccessHistoryScreen> {
  late Future<List<AccessLogEntry>> _future = AppScope.read(context).api.accessLog();

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: const Text('Access history')),
        body: FutureBuilder<List<AccessLogEntry>>(
          future: _future,
          builder: (context, snap) {
            if (snap.hasError) {
              return Center(
                child: Column(mainAxisSize: MainAxisSize.min, children: [
                  Text(snap.error is ApiException ? (snap.error as ApiException).message : 'Could not load the history.'),
                  const SizedBox(height: 12),
                  OutlinedButton(
                    onPressed: () => setState(() {
                      _future = AppScope.read(context).api.accessLog();
                    }),
                    child: const Text('Try again'),
                  ),
                ]),
              );
            }
            if (!snap.hasData) return const Center(child: CircularProgressIndicator());
            final list = snap.data!;
            return ListView(padding: const EdgeInsets.fromLTRB(20, 8, 20, 32), children: [
              const Text('Every time evidence is added, opened, shared or deleted. Only you see this.',
                  style: TextStyle(color: AppColors.muted, fontSize: 15, height: 1.4)),
              const SizedBox(height: 16),
              if (list.isEmpty)
                const AppCard(child: EmptyState(icon: Icons.history, text: 'Nothing yet.'))
              else
                MenuGroup(children: [
                  for (final e in list)
                    MenuRow(
                      icon: Icons.history,
                      title: _actionLabels[e.action] ?? e.action,
                      subtitle: [dateTime(e.at), if (e.device != null && e.device!.isNotEmpty) e.device!].join(' · '),
                      trailing: const SizedBox.shrink(),
                    ),
                ]),
            ]);
          },
        ),
      );
}
