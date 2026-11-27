import 'dart:async';

import 'package:flutter/material.dart';

import '../../api/api_client.dart';
import '../../api/maps_service.dart';
import '../../api/models.dart';
import '../../api/phase4_api.dart';
import '../../state/app_state.dart';
import '../../theme.dart';
import '../../widgets/common.dart';
import '../../widgets/format.dart';
import '../journey/journey_on_screen.dart';
import '../phase3/phase3_common.dart';
import 'phase4_common.dart';

Future<bool> _acceptDialog(BuildContext context, String title, String notice, String yes) async {
  final ok = await showDialog<bool>(
    context: context,
    builder: (c) => AlertDialog(
      title: Text(title),
      content: SingleChildScrollView(child: Text(notice)),
      actions: [
        TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('Cancel')),
        FilledButton(onPressed: () => Navigator.pop(c, true), child: Text(yes)),
      ],
    ),
  );
  return ok ?? false;
}

// ================= P4-06 Chhupa Rakshak (parent) =================

class ChhupaScreen extends StatefulWidget {
  const ChhupaScreen({super.key, required this.linkId, required this.childName});
  final String linkId;
  final String childName;
  @override
  State<ChhupaScreen> createState() => _ChhupaScreenState();
}

class _ChhupaScreenState extends State<ChhupaScreen> {
  late final AppState _state = AppScope.read(context);
  Key _k = UniqueKey();
  Timer? _poll;
  Map<String, dynamic>? _live;

  @override
  void dispose() {
    _poll?.cancel();
    super.dispose();
  }

  void _refresh() => setState(() => _k = UniqueKey());

  void _watch(String? sessionId) {
    _poll?.cancel();
    if (sessionId == null) return;
    Future<void> tick() async {
      try {
        final s = await _state.api.monitoringSession(sessionId);
        if (!mounted) return;
        setState(() => _live = s);
        if (s['status'] != 'active') _poll?.cancel();
      } catch (_) {}
    }

    tick();
    _poll = Timer.periodic(const Duration(seconds: 15), (_) => tick());
  }

  Future<void> _toggle(Map<String, dynamic> o, bool on) async {
    try {
      if (on) {
        if (!await _acceptDialog(context, 'Before you turn this on', '${o['notice']}', 'I understand and agree')) return;
        await _state.api.setMonitoringConsent(widget.linkId, true, accept: true);
      } else {
        await _state.api.setMonitoringConsent(widget.linkId, false);
        _poll?.cancel();
      }
      _refresh();
    } catch (e) {
      if (mounted) showError(context, e);
    }
  }

  Future<void> _start() async {
    final reason = TextEditingController();
    final ok = await showDialog<bool>(
      context: context,
      builder: (c) => AlertDialog(
        title: Text('Start a check on ${widget.childName}?'),
        content: Column(mainAxisSize: MainAxisSize.min, children: [
          const Text('Your child’s phone will show that this is on. It stops by itself after a short time.'),
          TextField(controller: reason, decoration: const InputDecoration(labelText: 'Why? (kept in the history)')),
        ]),
        actions: [TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('Cancel')), FilledButton(onPressed: () => Navigator.pop(c, true), child: const Text('Start'))],
      ),
    );
    if (ok != true) return;
    try {
      final s = await _state.api.startMonitoring(widget.linkId, _state.newId(), reason.text.trim());
      _refresh();
      _watch('${s['id']}');
    } catch (e) {
      if (mounted) showError(context, e);
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: Text('Chhupa Rakshak · ${widget.childName}')),
        body: P4Loader(
          key: _k,
          load: () => _state.api.monitoringOverview(widget.linkId),
          builder: (c, o, reload) {
            final active = o['active'] as Map<String, dynamic>?;
            if (active != null && _poll == null) WidgetsBinding.instance.addPostFrameCallback((_) => _watch('${active['id']}'));
            final live = _live != null && _live!['id'] == active?['id'] ? _live! : null;
            final last = live?['lastLocation'] as Map<String, dynamic>?;
            final history = (o['history'] as List).cast<Map<String, dynamic>>();
            return ListView(padding: const EdgeInsets.all(16), children: [
              const NoticeBox(icon: Icons.visibility_outlined, text: 'Your child’s phone always shows when this is on, and your child can stop it. Only location is shared. It is not a way to watch someone in secret.'),
              const SizedBox(height: 12),
              if (o['eligible'] != true) NoticeBox(text: '${o['notEligibleReason']}'),
              SwitchListTile(
                contentPadding: EdgeInsets.zero,
                title: const Text('Chhupa Rakshak', style: TextStyle(fontWeight: FontWeight.w700)),
                subtitle: Text(o['enabled'] == true ? 'On for ${widget.childName}' : 'Off'),
                value: o['enabled'] == true,
                onChanged: o['eligible'] == true ? (v) => _toggle(o, v) : null,
              ),
              if (active != null) ...[
                AppCard(
                  color: AppColors.redSoft,
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    const Text('Check in progress', style: TextStyle(fontWeight: FontWeight.w800, fontSize: 17)),
                    Text('Stops by ${clock(DateTime.parse('${active['expiresAt']}'))}'),
                    const SizedBox(height: 8),
                    if (last == null)
                      const Text('Waiting for the first location…')
                    else ...[
                      Text('Updated ${ago(DateTime.parse('${last['recordedAt']}'))}', style: const TextStyle(fontWeight: FontWeight.w700)),
                      if (last['stale'] == true) const Text('This is old. Do not treat it as where they are now.', style: TextStyle(color: AppColors.red)),
                      if (last['approximate'] == true) const Text('Approximate: weak GPS.', style: TextStyle(color: AppColors.muted)),
                      OutlinedButton.icon(onPressed: () => p4Directions(context, (last['lat'] as num).toDouble(), (last['lng'] as num).toDouble()), icon: const Icon(Icons.map), label: const Text('Open in maps')),
                    ],
                    TextButton(
                      onPressed: () async {
                        try {
                          await _state.api.stopMonitoring('${active['id']}');
                          _poll?.cancel();
                          _refresh();
                        } catch (e) {
                          if (context.mounted) showError(context, e);
                        }
                      },
                      child: const Text('Stop now'),
                    ),
                  ]),
                ),
              ] else if (o['enabled'] == true)
                FilledButton.icon(onPressed: _start, icon: const Icon(Icons.play_arrow), label: Text('Start a check (stops after ${o['expiryMinutes']} min)')),
              const SizedBox(height: 16),
              const SectionLabel('History'),
              if (history.isEmpty) const Text('No sessions yet.', style: TextStyle(color: AppColors.muted)),
              for (final h in history)
                ListTile(
                  contentPadding: EdgeInsets.zero,
                  leading: const Icon(Icons.history),
                  title: Text('${h['reason']}'),
                  subtitle: Text('${dateTime(DateTime.parse('${h['startedAt']}'))} · ${p4Label('${h['status']}')}${h['endReason'] != null ? ' (${p4Label('${h['endReason']}')})' : ''}'),
                ),
              const P4Disclaimer('Sarthi Rakshak alerts your guardians and helps you call 112. It is not a 24/7 monitoring service.'),
            ]);
          },
        ),
      );
}

/// Shown in Child mode: the child always sees when a session is on, can stop it, and sees the history.
class ChildMonitoringPanel extends StatefulWidget {
  const ChildMonitoringPanel({super.key});
  @override
  State<ChildMonitoringPanel> createState() => _ChildMonitoringPanelState();
}

class _ChildMonitoringPanelState extends State<ChildMonitoringPanel> {
  late final AppState _state = AppScope.read(context);
  Map<String, dynamic>? _data;
  Timer? _timer;

  @override
  void initState() {
    super.initState();
    _tick();
    _timer = Timer.periodic(const Duration(seconds: 30), (_) => _tick());
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  Future<void> _tick() async {
    try {
      final d = await _state.api.childMonitoring();
      final active = d['active'] as Map<String, dynamic>?;
      if (active != null) {
        final (pos, _) = await p4Position();
        if (pos != null) await _state.api.postMonitoringSample('${active['id']}', pos.latitude, pos.longitude, pos.accuracy);
      }
      if (mounted) setState(() => _data = d);
    } catch (_) {}
  }

  @override
  Widget build(BuildContext context) {
    final active = _data?['active'] as Map<String, dynamic>?;
    final history = ((_data?['history'] as List?) ?? const []).cast<Map<String, dynamic>>();
    if (active == null && history.isEmpty) return const SizedBox.shrink();
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      if (active != null)
        Container(
          margin: const EdgeInsets.only(bottom: 12),
          padding: const EdgeInsets.all(14),
          decoration: BoxDecoration(color: AppColors.red, borderRadius: BorderRadius.circular(14)),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('${active['parentName']} is checking your location', style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w800, fontSize: 16)),
            Text('Stops by ${clock(DateTime.parse('${active['expiresAt']}'))}. Only your location is shared.', style: const TextStyle(color: Colors.white)),
            TextButton(
              style: TextButton.styleFrom(foregroundColor: Colors.white),
              onPressed: () async {
                try {
                  final d = await _state.api.childStopMonitoring('${active['id']}');
                  if (mounted) setState(() => _data = d);
                } catch (e) {
                  if (context.mounted) showError(context, e);
                }
              },
              child: const Text('Stop now'),
            ),
          ]),
        ),
      if (history.isNotEmpty) ...[
        const SectionLabel('Past checks by your parent'),
        for (final h in history.take(5))
          ListTile(dense: true, contentPadding: EdgeInsets.zero, leading: const Icon(Icons.history), title: Text(dateTime(DateTime.parse('${h['startedAt']}'))), subtitle: Text('${p4Label('${h['status']}')}${h['endReason'] != null ? ' · ${p4Label('${h['endReason']}')}' : ''}')),
      ],
    ]);
  }
}

// ================= P4-07 School Monitoring =================

class SchoolsScreen extends StatefulWidget {
  const SchoolsScreen({super.key});
  @override
  State<SchoolsScreen> createState() => _SchoolsScreenState();
}

class _SchoolsScreenState extends State<SchoolsScreen> {
  late final AppState _state = AppScope.read(context);
  Key _k = UniqueKey();

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: const Text('School Monitoring')),
        floatingActionButton: FloatingActionButton.extended(
          icon: const Icon(Icons.add),
          label: const Text('Link a child'),
          onPressed: () async {
            await Navigator.push(context, MaterialPageRoute(builder: (_) => const AddSchoolLinkScreen()));
            if (mounted) setState(() => _k = UniqueKey());
          },
        ),
        body: P4Loader(
          key: _k,
          load: () => _state.api.schoolLinks(),
          builder: (c, items, reload) => RefreshIndicator(
            onRefresh: reload,
            child: ListView(padding: const EdgeInsets.fromLTRB(16, 16, 16, 90), children: [
              const NoticeBox(text: 'You see attendance, arrival and leaving that the school itself sends. Anything from the phone’s GPS is labelled separately. Missing news is shown as unknown, never as absent.'),
              const SizedBox(height: 12),
              if (items.isEmpty) const EmptyState(icon: Icons.school_outlined, text: 'No child linked to a school yet.'),
              for (final l in items)
                Padding(
                  padding: const EdgeInsets.only(bottom: 10),
                  child: AppCard(
                    onTap: () async {
                      await Navigator.push(context, MaterialPageRoute(builder: (_) => SchoolTimelineScreen(link: l)));
                      if (mounted) setState(() => _k = UniqueKey());
                    },
                    child: Row(children: [
                      Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                        Text('${l['childName']}', style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w700)),
                        Text('${l['schoolName']}', style: const TextStyle(color: AppColors.muted)),
                        if (l['staleFeed'] == true) const Text('The school has not sent anything recently.', style: TextStyle(color: AppColors.amber)),
                      ])),
                      StatusPill(p4Label('${l['status']}')),
                    ]),
                  ),
                ),
            ]),
          ),
        ),
      );
}

class AddSchoolLinkScreen extends StatefulWidget {
  const AddSchoolLinkScreen({super.key});
  @override
  State<AddSchoolLinkScreen> createState() => _AddSchoolLinkScreenState();
}

class _AddSchoolLinkScreenState extends State<AddSchoolLinkScreen> {
  late final AppState _state = AppScope.read(context);
  final _q = TextEditingController();
  final _name = TextEditingController();
  final _ref = TextEditingController();
  List<Map<String, dynamic>> _results = const [];
  Map<String, dynamic>? _school;
  Object? _error;

  @override
  void initState() {
    super.initState();
    _search();
  }

  Future<void> _search() async {
    try {
      final r = await _state.api.schoolDirectory(_q.text.trim());
      if (mounted) setState(() { _results = r; _error = null; });
    } catch (e) {
      if (mounted) setState(() => _error = e);
    }
  }

  Future<void> _send() async {
    try {
      await _state.api.createSchoolLink(_state.newId(), '${_school!['id']}', _name.text.trim(), _ref.text.trim());
      if (!mounted) return;
      showInfo(context, 'Request sent. The school will confirm it.');
      Navigator.pop(context);
    } catch (e) {
      if (mounted) showError(context, e);
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: const Text('Link a child to a school')),
        body: _error != null && phase4Unavailable(_error!)
            ? const NotAvailableYet()
            : ListView(padding: const EdgeInsets.all(16), children: [
                if (_school == null) ...[
                  TextField(controller: _q, onChanged: (_) => _search(), decoration: const InputDecoration(labelText: 'Search the approved schools', prefixIcon: Icon(Icons.search))),
                  const SizedBox(height: 8),
                  if (_results.isEmpty) const EmptyState(icon: Icons.school_outlined, text: 'No approved school found. Ask your school to join Sarthi Rakshak.'),
                  for (final s in _results) ListTile(title: Text('${s['name']}'), subtitle: Text('${s['city'] ?? ''}'), onTap: () => setState(() => _school = s)),
                ] else ...[
                  Text('${_school!['name']}', style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w800)),
                  const SizedBox(height: 12),
                  TextField(controller: _name, decoration: const InputDecoration(labelText: 'Child name')),
                  TextField(controller: _ref, decoration: const InputDecoration(labelText: 'Student ID or admission number (as the school has it)')),
                  const SizedBox(height: 16),
                  BusyButton(label: 'Send request', onPressed: _send),
                  const P4Disclaimer('The school must confirm that you are the parent. Until then nothing is shown.'),
                ],
              ]),
      );
}

class SchoolTimelineScreen extends StatelessWidget {
  const SchoolTimelineScreen({super.key, required this.link});
  final Map<String, dynamic> link;
  @override
  Widget build(BuildContext context) {
    final s = AppScope.read(context);
    return Scaffold(
      appBar: AppBar(title: Text('${link['childName']}')),
      body: P4Loader(
        load: () => s.api.schoolEvents('${link['id']}'),
        builder: (c, d, reload) {
          final items = ((d['items'] as List?) ?? const []).cast<Map<String, dynamic>>();
          return ListView(padding: const EdgeInsets.all(16), children: [
            Text('${link['schoolName']}', style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 17)),
            StatusPill(p4Label('${link['status']}')),
            if (link['staleFeed'] == true) const Padding(padding: EdgeInsets.only(top: 8), child: NoticeBox(text: 'The school has not sent anything recently. No news is not the same as absent.')),
            if (d['note'] != null) Padding(padding: const EdgeInsets.only(top: 8), child: Text('${d['note']}')),
            const SizedBox(height: 12),
            for (final e in items)
              ListTile(
                contentPadding: EdgeInsets.zero,
                leading: Icon(e['correction'] == true ? Icons.edit_note : Icons.school_outlined),
                title: Text('${e['label']}'),
                subtitle: Text('From the school · ${dateTime(DateTime.parse('${e['occurredAt']}'))}\nSynced ${ago(DateTime.parse('${e['syncedAt']}'))}${e['reason'] != null ? '\nReason: ${e['reason']}' : ''}'),
                isThreeLine: true,
              ),
            if (items.isEmpty && d['note'] == null) const Text('Nothing from the school yet.', style: TextStyle(color: AppColors.muted)),
            TextButton(
              onPressed: () async {
                if (!await confirm(context, 'Stop this link?', 'You will no longer see events for this child.', yes: 'Stop', danger: true)) return;
                try {
                  await s.api.revokeSchoolLink('${link['id']}');
                  if (context.mounted) Navigator.pop(context);
                } catch (e) {
                  if (context.mounted) showError(context, e);
                }
              },
              child: const Text('Stop this link', style: TextStyle(color: AppColors.red)),
            ),
            const P4Disclaimer('A phone journey is not proof of attendance. Only the school can confirm attendance.'),
          ]);
        },
      ),
    );
  }
}

// ================= P4-08 Cyberbullying Detection =================

class CyberScreen extends StatefulWidget {
  const CyberScreen({super.key, required this.linkId});
  final String linkId;
  @override
  State<CyberScreen> createState() => _CyberScreenState();
}

class _CyberScreenState extends State<CyberScreen> {
  late final AppState _state = AppScope.read(context);
  Key _k = UniqueKey();
  final _text = TextEditingController();

  void _refresh() => setState(() => _k = UniqueKey());

  Future<void> _toggle(Map<String, dynamic> o, bool on) async {
    try {
      if (on) {
        if (!await _acceptDialog(context, 'Before you turn this on', '${o['notice']}', 'I understand and agree')) return;
        await _state.api.setCyberSource(widget.linkId, true, accept: true);
      } else {
        await _state.api.setCyberSource(widget.linkId, false);
      }
      _refresh();
    } catch (e) {
      if (mounted) showError(context, e);
    }
  }

  Future<void> _check() async {
    try {
      final r = await _state.api.cyberAnalyse(widget.linkId, _text.text.trim());
      _text.clear();
      if (!mounted) return;
      showInfo(context, r['flagged'] == 0 ? 'Nothing worrying was found.' : '${r['flagged']} possible concern(s) found.');
      _refresh();
    } catch (e) {
      if (mounted) showError(context, e);
    }
  }

  Future<void> _review(Map<String, dynamic> f, String status) async {
    try {
      await _state.api.cyberReview('${f['id']}', status);
      _refresh();
    } catch (e) {
      if (mounted) showError(context, e);
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: const Text('Cyberbullying check')),
        body: P4Loader(
          key: _k,
          load: () => _state.api.cyberOverview(widget.linkId),
          builder: (c, o, reload) {
            final isParent = o['isParent'] == true;
            final src = ((o['sources'] as List).first as Map).cast<String, dynamic>();
            final flags = (o['flags'] as List).cast<Map<String, dynamic>>();
            final on = src['enabled'] == true;
            return ListView(padding: const EdgeInsets.all(16), children: [
              NoticeBox(icon: Icons.shield_outlined, text: '${o['notice']}'),
              const SizedBox(height: 8),
              if (isParent)
                SwitchListTile(contentPadding: EdgeInsets.zero, title: Text('${src['label']}'), subtitle: Text(on ? 'On' : 'Off until you agree'), value: on, onChanged: o['eligible'] == true ? (v) => _toggle(o, v) : null)
              else
                ListTile(contentPadding: EdgeInsets.zero, title: Text('${src['label']}'), subtitle: Text(on ? 'Your parent turned this on' : 'Your parent has not turned this on')),
              if (on) ...[
                TextField(controller: _text, maxLines: 4, maxLength: 5000, decoration: const InputDecoration(labelText: 'Paste a message to check')),
                BusyButton(label: 'Check this message', onPressed: _check),
              ],
              const SizedBox(height: 16),
              const SectionLabel('Concerns found'),
              if (flags.isEmpty) const Text('None.', style: TextStyle(color: AppColors.muted)),
              for (final f in flags)
                Padding(
                  padding: const EdgeInsets.only(bottom: 10),
                  child: AppCard(
                    child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Row(children: [
                        Expanded(child: Text(p4Label('${f['category']}'), style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 16))),
                        StatusPill('${f['label']}', color: f['label'] == 'Uncertain' ? AppColors.muted : AppColors.red),
                      ]),
                      Text('${f['source']} · ${dateTime(DateTime.parse('${f['createdAt']}'))}', style: const TextStyle(color: AppColors.muted, fontSize: 13)),
                      const SizedBox(height: 6),
                      if (f['excerpt'] != null) Text('“${f['excerpt']}”'),
                      const SizedBox(height: 4),
                      Text('${f['explanation']}', style: const TextStyle(fontSize: 13.5)),
                      Text('Status: ${p4Label('${f['status']}')}', style: const TextStyle(color: AppColors.muted)),
                      if (isParent && f['status'] == 'new')
                        Wrap(spacing: 8, children: [
                          OutlinedButton(onPressed: () => _review(f, 'reviewed'), child: const Text('Reviewed')),
                          OutlinedButton(onPressed: () => _review(f, 'false_positive'), child: const Text('Not a problem')),
                          OutlinedButton(onPressed: () => _review(f, 'dismissed'), child: const Text('Dismiss')),
                        ]),
                    ]),
                  ),
                ),
              const P4Disclaimer('A flag is a risk signal for a person to review, not proof. The other person is never contacted. If someone is in danger, use SOS or call 112.'),
            ]);
          },
        ),
      );
}

// ================= P4-12 Smart Glasses =================

class GlassesScreen extends StatefulWidget {
  const GlassesScreen({super.key});
  @override
  State<GlassesScreen> createState() => _GlassesScreenState();
}

class _GlassesScreenState extends State<GlassesScreen> {
  late final AppState _state = AppScope.read(context);
  Key _k = UniqueKey();

  Future<void> _pair(Map<String, dynamic> model) async {
    final dev = TextEditingController();
    final fw = TextEditingController();
    final ok = await showDialog<bool>(
      context: context,
      builder: (c) => AlertDialog(
        title: Text('Add ${model['manufacturer']} ${model['model']}'),
        content: Column(mainAxisSize: MainAxisSize.min, children: [
          TextField(controller: dev, decoration: const InputDecoration(labelText: 'Device ID (from the glasses)')),
          TextField(controller: fw, decoration: InputDecoration(labelText: 'Firmware version (needs ${model['minFirmware']} or newer)')),
        ]),
        actions: [TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('Cancel')), FilledButton(onPressed: () => Navigator.pop(c, true), child: const Text('Check and add'))],
      ),
    );
    if (ok != true) return;
    try {
      await _state.api.pairGlasses(_state.newId(), '${model['id']}', dev.text.trim(), fw.text.trim());
      if (mounted) setState(() => _k = UniqueKey());
    } catch (e) {
      if (mounted) showError(context, e);
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: const Text('Smart Glasses')),
        body: P4Loader(
          key: _k,
          load: () async => (await _state.api.glassesModels(), await _state.api.myGlasses()),
          builder: (c, d, reload) {
            final (m, mine) = d;
            final models = (m['items'] as List).cast<Map<String, dynamic>>();
            return ListView(padding: const EdgeInsets.all(16), children: [
              NoticeBox(icon: Icons.videocam_outlined, text: '${m['notice']}'),
              const SizedBox(height: 12),
              const SectionLabel('My glasses'),
              if (mine.isEmpty) const Text('No glasses added.', style: TextStyle(color: AppColors.muted)),
              for (final g in mine)
                Padding(
                  padding: const EdgeInsets.only(bottom: 10),
                  child: AppCard(
                    child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Row(children: [
                        Expanded(child: Text('${g['name']}', style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 16))),
                        StatusPill(g['status'] == 'paired' ? 'Added' : 'Blocked', color: g['status'] == 'paired' ? AppColors.green : AppColors.red),
                      ]),
                      Text('Firmware ${g['firmware']}${g['batteryPct'] != null ? ' · battery ${g['batteryPct']}%' : ''}', style: const TextStyle(color: AppColors.muted)),
                      if (g['blockReason'] != null) Text('${g['blockReason']}', style: const TextStyle(color: AppColors.red)),
                      if (g['status'] == 'paired') ...[
                        const SizedBox(height: 6),
                        const Text('Recording from the glasses needs the maker’s SDK, which is not part of this app version. Nothing is recorded.', style: TextStyle(fontSize: 13, color: AppColors.muted)),
                        Text('Queued uploads: ${g['queuedUploads']}', style: const TextStyle(fontSize: 13)),
                      ],
                      TextButton(
                        onPressed: () async {
                          try {
                            await _state.api.unpairGlasses('${g['id']}');
                            if (mounted) setState(() => _k = UniqueKey());
                          } catch (e) {
                            if (context.mounted) showError(context, e);
                          }
                        },
                        child: const Text('Remove'),
                      ),
                    ]),
                  ),
                ),
              const SizedBox(height: 8),
              const SectionLabel('Supported models'),
              if (models.isEmpty) const Text('No models are supported yet.', style: TextStyle(color: AppColors.muted)),
              for (final md in models)
                ListTile(
                  contentPadding: EdgeInsets.zero,
                  title: Text('${md['manufacturer']} ${md['model']}'),
                  subtitle: Text('Firmware ${md['minFirmware']}+${md['knownLimits'] != null ? '\n${md['knownLimits']}' : ''}'),
                  trailing: md['supported'] == true ? TextButton(onPressed: () => _pair(md), child: const Text('Add')) : const StatusPill('Not supported', color: AppColors.red),
                ),
            ]);
          },
        ),
      );
}

// ================= P4-13 Safer Route =================

class SafeRouteScreen extends StatefulWidget {
  const SafeRouteScreen({super.key});
  @override
  State<SafeRouteScreen> createState() => _SafeRouteScreenState();
}

class _SafeRouteScreenState extends State<SafeRouteScreen> {
  late final AppState _state = AppScope.read(context);
  final _maps = MapsService();
  final _search = TextEditingController();
  Timer? _debounce;
  List<PlaceResult> _results = const [];
  PlaceResult? _dest;
  Map<String, dynamic>? _reply;
  String _mode = 'walking';
  bool _busy = false;
  String? _problem;
  Object? _error;

  @override
  void dispose() {
    _debounce?.cancel();
    super.dispose();
  }

  void _onSearch(String text) {
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 400), () async {
      if (text.trim().length < 3 || !_maps.canSearch) return;
      try {
        final r = await _maps.search(text);
        if (mounted) setState(() => _results = r);
      } catch (_) {}
    });
  }

  Future<void> _find() async {
    if (_dest == null) return;
    setState(() { _busy = true; _problem = null; _error = null; _reply = null; });
    final (pos, why) = await p4Position();
    if (pos == null) {
      if (mounted) setState(() { _busy = false; _problem = why; });
      return;
    }
    try {
      final r = await _state.api.safeRoutes(pos.latitude, pos.longitude, _dest!.lat, _dest!.lng, _mode);
      if (mounted) setState(() => _reply = r);
    } catch (e) {
      if (mounted) setState(() => _error = e);
    }
    if (mounted) setState(() => _busy = false);
  }

  Future<void> _go(Map<String, dynamic> r) async {
    final dest = Place(lat: _dest!.lat, lng: _dest!.lng, label: _dest!.name);
    try {
      final journey = await _state.api.startJourney(_state.newId(), dest, DateTime.now().add(Duration(minutes: (r['etaMinutes'] as num).toInt() + 15)),
          (r['polyline'] as String?)?.isEmpty ?? true ? null : r['polyline'] as String);
      await _state.engine.startJourney(journey: journey, rules: _state.me?.rules ?? const {});
      if (!mounted) return;
      Navigator.pushReplacement(context, MaterialPageRoute(builder: (_) => JourneyOnScreen(journeyId: journey.id)));
    } on ApiException catch (e) {
      if (mounted) showError(context, e);
    }
  }

  Future<void> _feedback() async {
    final text = TextEditingController();
    final ok = await showDialog<bool>(
      context: context,
      builder: (c) => AlertDialog(
        title: const Text('Report a problem with this route'),
        content: TextField(controller: text, maxLines: 3, decoration: const InputDecoration(labelText: 'What is wrong?')),
        actions: [TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('Cancel')), FilledButton(onPressed: () => Navigator.pop(c, true), child: const Text('Send'))],
      ),
    );
    if (ok != true) return;
    try {
      await _state.api.safeRouteFeedback(_state.newId(), _reply?['routeScoreId'] as String?, 'inaccurate', text.text.trim());
      if (mounted) showInfo(context, 'Thank you. This goes to a review queue.');
    } catch (e) {
      if (mounted) showError(context, e);
    }
  }

  static const _bandText = {
    'lower_risk': 'Lower reported risk',
    'some_risk': 'Some reported risk',
    'higher_risk': 'Higher reported risk',
    'unknown': 'Not enough data',
  };

  @override
  Widget build(BuildContext context) {
    final items = ((_reply?['items'] as List?) ?? const []).cast<Map<String, dynamic>>();
    return Scaffold(
      appBar: AppBar(title: const Text('Safer route')),
      body: ListView(padding: const EdgeInsets.all(16), children: [
        TextField(controller: _search, onChanged: _onSearch, decoration: InputDecoration(labelText: 'Where to?', prefixIcon: const Icon(Icons.search), suffixIcon: _dest == null ? null : const Icon(Icons.check_circle, color: AppColors.green))),
        for (final r in _results.take(5))
          ListTile(title: Text(r.name), subtitle: Text(r.address), onTap: () => setState(() { _dest = r; _results = const []; _search.text = r.name; })),
        Wrap(spacing: 8, children: [
          for (final m in const {'walking': 'Walk', 'driving': 'Drive', 'bicycling': 'Cycle'}.entries) PillChoice(label: m.value, selected: _mode == m.key, onSelected: (_) => setState(() => _mode = m.key)),
        ]),
        const SizedBox(height: 8),
        FilledButton(onPressed: _dest == null || _busy ? null : _find, child: _busy ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2)) : const Text('Compare routes')),
        if (_problem != null) Padding(padding: const EdgeInsets.only(top: 8), child: Text(_problem!)),
        if (_error != null) SizedBox(height: 200, child: phase4Unavailable(_error!) ? const NotAvailableYet() : LoadFailed(error: _error!, onRetry: _find)),
        if (_reply != null) ...[
          const SizedBox(height: 12),
          NoticeBox(icon: Icons.info_outline, text: '${_reply!['notice']}'),
          if (_reply!['providerAvailable'] == false) Padding(padding: const EdgeInsets.all(12), child: Text('${_reply!['message']}')),
          if (_reply!['providerAvailable'] == true && items.isEmpty) Padding(padding: const EdgeInsets.all(12), child: Text('${_reply!['message'] ?? 'No routes found.'}')),
          for (final r in items)
            Padding(
              padding: const EdgeInsets.only(top: 10),
              child: AppCard(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Row(children: [
                    Expanded(child: Text('${r['summary']}', style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 17))),
                    if (r['isFastest'] == true) const StatusPill('Fastest', color: AppColors.muted),
                  ]),
                  Text('${r['etaMinutes']} min · ${p4Distance((r['distanceM'] as num?) ?? 0)}'),
                  const SizedBox(height: 4),
                  Text(_bandText[(r['score'] as Map)['band']] ?? '', style: const TextStyle(fontWeight: FontWeight.w700)),
                  Text('Confidence: ${p4Label('${(r['score'] as Map)['confidence']}')}${(r['score'] as Map)['newestDataAt'] != null ? ' · data from ${dateTime(DateTime.parse('${(r['score'] as Map)['newestDataAt']}'))}' : ''}', style: const TextStyle(color: AppColors.muted, fontSize: 13)),
                  for (final f in ((r['score'] as Map)['factors'] as List).cast<Map>())
                    Text('${f['effect'] == 'raises' ? '▲' : '▼'} ${f['label']} (${f['count']})', style: const TextStyle(fontSize: 13.5)),
                  Text('${(r['score'] as Map)['note']}', style: const TextStyle(fontSize: 12.5, color: AppColors.muted)),
                  const SizedBox(height: 6),
                  FilledButton(onPressed: () => _go(r), child: const Text('Start journey on this route')),
                ]),
              ),
            ),
          if (items.isNotEmpty) ...[
            if ((_reply!['staleSources'] as List?)?.isNotEmpty == true) Padding(padding: const EdgeInsets.only(top: 8), child: Text('Some data is out of date: ${(_reply!['staleSources'] as List).join(', ')}.', style: const TextStyle(color: AppColors.amber))),
            Text('Scored ${dateTime(DateTime.parse('${_reply!['scoredAt']}'))} · model ${_reply!['modelVersion'] ?? 'none'}', style: const TextStyle(color: AppColors.muted, fontSize: 12.5)),
            TextButton(onPressed: _feedback, child: const Text('Report a problem with this score')),
          ],
        ],
      ]),
    );
  }
}

// ================= P4-14 Police / ERSS: honest handoff status on the SOS screen =================

class HandoffStatus extends StatefulWidget {
  const HandoffStatus({super.key, required this.sosId});
  final String sosId;
  @override
  State<HandoffStatus> createState() => _HandoffStatusState();
}

class _HandoffStatusState extends State<HandoffStatus> {
  late final AppState _state = AppScope.read(context);
  Map<String, dynamic>? _s;
  Timer? _timer;

  @override
  void initState() {
    super.initState();
    _tick();
    _timer = Timer.periodic(const Duration(seconds: 10), (_) => _tick());
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  Future<void> _tick() async {
    try {
      final s = await _state.api.sosHandoff(widget.sosId);
      if (mounted) setState(() => _s = s);
    } catch (_) {
      // Not on the server yet or switched off: show nothing. Call 112 is always on the screen.
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = _s;
    if (s == null || s['enabled'] != true) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(top: 10),
      child: NoticeBox(icon: Icons.local_police_outlined, color: AppColors.ink, background: Colors.white, text: '${s['label']}. ${s['detail']}'),
    );
  }
}
