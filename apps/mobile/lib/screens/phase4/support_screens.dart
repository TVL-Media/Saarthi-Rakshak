import 'package:flutter/material.dart';

import '../../api/phase4_api.dart';
import '../../state/app_state.dart';
import '../../theme.dart';
import '../../widgets/common.dart';
import '../../widgets/format.dart';
import '../fakecall/fake_call_screen.dart';
import '../sos/sos_countdown_screen.dart';
import '../vault/vault_screen.dart';
import 'phase4_common.dart';
import 'safe_places_screen.dart';
import 'tools_screen.dart';

void _push(BuildContext c, Widget w) => Navigator.push(c, MaterialPageRoute(builder: (_) => w));

/// Women Safety home: the fast tools first, then reports, support and guidance.
class WomenSafetyScreen extends StatelessWidget {
  const WomenSafetyScreen({super.key});
  @override
  Widget build(BuildContext context) {
    final s = AppScope.read(context);
    return Scaffold(
      appBar: AppBar(title: const Text('Women Safety')),
      body: ListView(padding: const EdgeInsets.all(16), children: [
        SizedBox(
          height: 80,
          child: FilledButton.icon(
            style: FilledButton.styleFrom(backgroundColor: AppColors.red, textStyle: const TextStyle(fontSize: 22, fontWeight: FontWeight.w800)),
            icon: const Icon(Icons.sos, size: 32),
            label: const Text('SOS'),
            onPressed: () => _push(context, const SosCountdownScreen(trigger: 'button')),
          ),
        ),
        const SizedBox(height: 16),
        MenuGroup(label: 'Quick tools', children: [
          if (s.feature4('night_mode')) MenuRow(icon: Icons.nightlight_outlined, title: 'Night Mode', subtitle: 'Essential tools on one screen', accent: true, onTap: () => _push(context, const ToolsScreen())),
          if (s.feature4('safe_places')) MenuRow(icon: Icons.local_police_outlined, title: 'Safe places', subtitle: 'Police, hospitals, help desks', accent: true, onTap: () => _push(context, const SafePlacesScreen())),
          MenuRow(icon: Icons.phone_in_talk_outlined, title: 'Fake call', subtitle: 'Does not call anyone', accent: true, onTap: () => _push(context, const FakeCallScreen())),
          if (s.feature('vault')) MenuRow(icon: Icons.lock_outline, title: 'Save evidence', subtitle: 'Photos, audio and notes go to Mere Saboot', accent: true, onTap: () => _push(context, const VaultScreen())),
        ]),
        MenuGroup(label: 'Report and support', children: [
          MenuRow(icon: Icons.edit_note, title: 'Report harassment', subtitle: 'Private by default. Nothing is sent to police.', accent: true, onTap: () => _push(context, const IncidentListScreen(group: 'women', title: 'Harassment reports', kind: 'harassment'))),
          MenuRow(icon: Icons.volunteer_activism_outlined, title: 'Support organisations', subtitle: 'Counselling and help partners', accent: true, onTap: () => _push(context, const PartnersScreen(kind: 'women_support', title: 'Support organisations'))),
          MenuRow(icon: Icons.menu_book_outlined, title: 'What to do', subtitle: 'Step-by-step safety guidance', accent: true, onTap: () => _push(context, const GuidanceScreen())),
          const MenuRow(icon: Icons.alt_route, title: 'Safer route', subtitle: 'Not available yet. We do not guess how safe a road is.', trailing: SizedBox()),
        ]),
        const NoticeBox(text: 'Sarthi Rakshak alerts your guardians and helps you call 112. It is not a 24/7 monitoring service.'),
      ]),
    );
  }
}

/// Men's Safety and Legal Support.
class LegalSupportScreen extends StatelessWidget {
  const LegalSupportScreen({super.key});
  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: const Text("Men's Safety & Legal Support")),
        body: ListView(padding: const EdgeInsets.all(16), children: [
          MenuGroup(label: 'Reports', children: [
            MenuRow(icon: Icons.business_center_outlined, title: 'Workplace report', subtitle: 'Harassment or pressure at work', accent: true, onTap: () => _push(context, const IncidentListScreen(group: 'men', title: 'My reports', kind: 'workplace'))),
            MenuRow(icon: Icons.gavel, title: 'A disputed allegation', subtitle: 'Keep your own record. Nobody is called guilty here.', accent: true, onTap: () => _push(context, const IncidentListScreen(group: 'men', title: 'My reports', kind: 'false_accusation'))),
          ]),
          MenuGroup(label: 'Legal help', children: [
            MenuRow(icon: Icons.balance, title: 'Find a lawyer', subtitle: 'Verified directory', accent: true, onTap: () => _push(context, const PartnersScreen(kind: 'lawyer', title: 'Lawyers'))),
            MenuRow(icon: Icons.track_changes, title: 'My requests', subtitle: 'Track a consultation request', accent: true, onTap: () => _push(context, const RequestsScreen())),
          ]),
          const NoticeBox(text: 'We connect you with independent lawyers. Sarthi Rakshak does not give legal advice and does not guarantee any result.'),
        ]),
      );
}

// ---- Guidance ----
class GuidanceScreen extends StatelessWidget {
  const GuidanceScreen({super.key});
  @override
  Widget build(BuildContext context) {
    final s = AppScope.read(context);
    return Scaffold(
      appBar: AppBar(title: const Text('What to do')),
      body: P4Loader(
        load: () => s.api.guidance(),
        builder: (c, r, reload) => ListView(padding: const EdgeInsets.all(16), children: [
          if (r.items.isEmpty) const EmptyState(icon: Icons.menu_book_outlined, text: 'No guidance has been published yet.'),
          for (final g in r.items)
            Padding(
              padding: const EdgeInsets.only(bottom: 10),
              child: AppCard(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text('${g['title']}', style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w700)),
                  Text(p4Label('${g['situation']}'), style: const TextStyle(color: AppColors.muted)),
                  const SizedBox(height: 8),
                  for (final (i, step) in ((g['steps'] as List?) ?? const []).indexed) Padding(padding: const EdgeInsets.only(bottom: 4), child: Text('${i + 1}. $step')),
                ]),
              ),
            ),
          P4Disclaimer(r.disclaimer ?? p4NotMedical),
        ]),
      ),
    );
  }
}

// ---- Partners and requests ----
class PartnersScreen extends StatelessWidget {
  const PartnersScreen({super.key, required this.kind, required this.title});
  final String kind;
  final String title;
  @override
  Widget build(BuildContext context) {
    final s = AppScope.read(context);
    return Scaffold(
      appBar: AppBar(title: Text(title)),
      body: P4Loader(
        load: () => s.api.partners(kind),
        builder: (c, items, reload) => ListView(padding: const EdgeInsets.all(16), children: [
          if (items.isEmpty) const EmptyState(icon: Icons.groups_outlined, text: 'No verified partners are listed yet.'),
          for (final p in items)
            Padding(
              padding: const EdgeInsets.only(bottom: 10),
              child: AppCard(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Row(children: [
                    Expanded(child: Text('${p['name']}', style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w700))),
                    if (p['verified'] == true) const StatusPill('Verified', color: AppColors.green),
                  ]),
                  Text('${p4Label('${p['category']}')}${p['city'] != null ? ' · ${p['city']}' : ''}', style: const TextStyle(color: AppColors.muted)),
                  if (p['services'] != null) Text('${p['services']}'),
                  if (p['languages'] != null) Text('Languages: ${p['languages']}', style: const TextStyle(color: AppColors.muted)),
                  if (p['hours'] != null) Text('Hours: ${p['hours']}', style: const TextStyle(color: AppColors.muted)),
                  const SizedBox(height: 8),
                  Wrap(spacing: 8, children: [
                    if (p['phone'] != null) OutlinedButton.icon(onPressed: () => p4Call(context, '${p['phone']}'), icon: const Icon(Icons.call), label: const Text('Call')),
                    FilledButton(onPressed: () => _push(context, RequestFormScreen(kind: kind == 'lawyer' ? 'legal' : 'women_support', partner: p)), child: const Text('Request help')),
                  ]),
                ]),
              ),
            ),
          const P4Disclaimer('A Verified badge means we checked the organisation. It is not a guarantee of any result.'),
        ]),
      ),
    );
  }
}

class RequestFormScreen extends StatefulWidget {
  const RequestFormScreen({super.key, required this.kind, required this.partner});
  final String kind;
  final Map<String, dynamic> partner;
  @override
  State<RequestFormScreen> createState() => _RequestFormScreenState();
}

class _RequestFormScreenState extends State<RequestFormScreen> {
  late final AppState _state = AppScope.read(context);
  late final String _id = _state.newId();
  final _summary = TextEditingController();
  String _urgency = 'normal';
  String _contact = 'phone';

  @override
  void dispose() {
    _summary.dispose();
    super.dispose();
  }

  Future<void> _send() async {
    try {
      final r = await _state.api.createPartnerRequest({
        'id': _id,
        'kind': widget.kind,
        'partnerId': widget.partner['id'],
        'category': widget.partner['category'] ?? 'general',
        'urgency': _urgency,
        'preferredContact': _contact,
        'summary': _summary.text.trim(),
        'sharedItemIds': <String>[],
        'sharedDays': 14,
      });
      if (!mounted) return;
      showInfo(context, 'Request sent. Reference ${r['reference'] ?? ''}');
      Navigator.pop(context);
    } catch (e) {
      if (mounted) showError(context, e);
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: Text('Request to ${widget.partner['name']}')),
        body: ListView(padding: const EdgeInsets.all(16), children: [
          const NoticeBox(text: 'Only what you write here is shared with this organisation. Your evidence is not shared unless you choose it.'),
          const SizedBox(height: 12),
          TextField(controller: _summary, maxLines: 5, maxLength: 1000, decoration: const InputDecoration(labelText: 'Short summary of what you need')),
          const SizedBox(height: 8),
          Wrap(spacing: 8, children: [
            for (final u in const ['low', 'normal', 'urgent']) PillChoice(label: p4Label(u), selected: _urgency == u, onSelected: (_) => setState(() => _urgency = u)),
          ]),
          const SizedBox(height: 8),
          Wrap(spacing: 8, children: [
            for (final u in const ['phone', 'sms', 'any']) PillChoice(label: 'Contact: $u', selected: _contact == u, onSelected: (_) => setState(() => _contact = u)),
          ]),
          const SizedBox(height: 16),
          BusyButton(label: 'Send request', onPressed: _send),
          const P4Disclaimer('In an emergency call 112. This is not an emergency service.'),
        ]),
      );
}

class RequestsScreen extends StatelessWidget {
  const RequestsScreen({super.key});
  @override
  Widget build(BuildContext context) {
    final s = AppScope.read(context);
    return Scaffold(
      appBar: AppBar(title: const Text('My requests')),
      body: P4Loader(
        load: () => s.api.partnerRequests(),
        builder: (c, items, reload) => RefreshIndicator(
          onRefresh: reload,
          child: ListView(padding: const EdgeInsets.all(16), children: [
            if (items.isEmpty) const EmptyState(icon: Icons.inbox_outlined, text: 'No requests yet.'),
            for (final r in items)
              Padding(
                padding: const EdgeInsets.only(bottom: 10),
                child: AppCard(
                  onTap: () => _push(context, RequestDetailScreen(id: '${r['id']}')),
                  child: Row(children: [
                    Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Text('${r['partnerName'] ?? 'Request'}', style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 16)),
                      Text('${r['reference'] ?? ''}', style: const TextStyle(color: AppColors.muted)),
                    ])),
                    StatusPill(p4Label('${r['status']}')),
                  ]),
                ),
              ),
          ]),
        ),
      ),
    );
  }
}

class RequestDetailScreen extends StatelessWidget {
  const RequestDetailScreen({super.key, required this.id});
  final String id;
  @override
  Widget build(BuildContext context) {
    final s = AppScope.read(context);
    return Scaffold(
      appBar: AppBar(title: const Text('Request')),
      body: P4Loader(
        load: () => s.api.partnerRequest(id),
        builder: (c, r, reload) => ListView(padding: const EdgeInsets.all(16), children: [
          Text('${r['reference'] ?? ''}', style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w800)),
          Text('${r['partnerName'] ?? ''}'),
          StatusPill(p4Label('${r['status']}')),
          const SizedBox(height: 12),
          const SectionLabel('Progress'),
          for (final t in ((r['timeline'] as List?) ?? const []))
            ListTile(dense: true, leading: const Icon(Icons.check_circle_outline), title: Text(p4Label('${(t as Map)['status'] ?? t['action'] ?? ''}')), subtitle: Text('${t['at'] ?? ''}')),
          if (r['partnerPhone'] != null) OutlinedButton.icon(onPressed: () => p4Call(context, '${r['partnerPhone']}'), icon: const Icon(Icons.call), label: const Text('Call partner')),
          if (r['status'] != 'closed')
            TextButton(
              onPressed: () async {
                if (!await confirm(context, 'Close this request?', 'Sharing stops and the organisation will no longer see your details.', yes: 'Close')) return;
                try {
                  await s.api.closePartnerRequest(id);
                  if (context.mounted) Navigator.pop(context);
                } catch (e) {
                  if (context.mounted) showError(context, e);
                }
              },
              child: const Text('Close request'),
            ),
          P4Disclaimer('${r['disclaimer'] ?? p4NotMedical}'),
        ]),
      ),
    );
  }
}

// ---- Incident reports ----
class IncidentListScreen extends StatelessWidget {
  const IncidentListScreen({super.key, required this.group, required this.title, required this.kind});
  final String group;
  final String title;
  final String kind;
  @override
  Widget build(BuildContext context) {
    final s = AppScope.read(context);
    return Scaffold(
      appBar: AppBar(title: Text(title)),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: () => _push(context, IncidentFormScreen(kind: kind)),
        icon: const Icon(Icons.add),
        label: const Text('New report'),
      ),
      body: P4Loader(
        load: () => s.api.incidentReports(group),
        builder: (c, items, reload) => ListView(padding: const EdgeInsets.fromLTRB(16, 16, 16, 90), children: [
          const NoticeBox(text: 'Reports are private by default. Police are never contacted automatically.'),
          const SizedBox(height: 12),
          if (items.isEmpty) const EmptyState(icon: Icons.description_outlined, text: 'No reports yet.'),
          for (final r in items)
            Padding(
              padding: const EdgeInsets.only(bottom: 10),
              child: AppCard(
                onTap: () => _push(context, IncidentFormScreen(kind: '${r['kind']}', existingId: '${r['id']}')),
                child: Row(children: [
                  Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text(p4Label('${r['category']}'), style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 16)),
                    Text('${r['reference'] ?? 'Draft'}', style: const TextStyle(color: AppColors.muted)),
                  ])),
                  StatusPill(p4Label('${r['status']}')),
                ]),
              ),
            ),
        ]),
      ),
    );
  }
}

class IncidentFormScreen extends StatefulWidget {
  const IncidentFormScreen({super.key, required this.kind, this.existingId});
  final String kind;
  final String? existingId;
  @override
  State<IncidentFormScreen> createState() => _IncidentFormScreenState();
}

class _IncidentFormScreenState extends State<IncidentFormScreen> {
  late final AppState _state = AppScope.read(context);
  late final String _id = widget.existingId ?? _state.newId();
  final _desc = TextEditingController();
  final _place = TextEditingController();
  final _org = TextEditingController();
  late String _category = widget.kind == 'harassment' ? 'street' : widget.kind == 'workplace' ? 'harassment' : 'allegation';
  String _route = 'private';
  bool _risk = false;
  bool _readOnly = false;
  bool _loading = false;
  DateTime _when = DateTime.now();

  @override
  void initState() {
    super.initState();
    if (widget.existingId != null) _loadExisting();
  }

  Future<void> _loadExisting() async {
    setState(() => _loading = true);
    try {
      final r = await _state.api.incidentReport(_id);
      _desc.text = '${r['description'] ?? ''}';
      _place.text = '${r['placeLabel'] ?? ''}';
      _org.text = '${r['organisation'] ?? ''}';
      _category = '${r['category'] ?? _category}';
      _route = '${r['route'] ?? 'private'}';
      _risk = r['immediateRisk'] == true;
      _readOnly = r['status'] != 'draft';
      final at = r['occurredAt'];
      if (at is String) _when = DateTime.tryParse(at)?.toLocal() ?? _when;
    } catch (e) {
      if (mounted) showError(context, e);
    }
    if (mounted) setState(() => _loading = false);
  }

  @override
  void dispose() {
    _desc.dispose();
    _place.dispose();
    _org.dispose();
    super.dispose();
  }

  Future<void> _save(bool submit) async {
    try {
      final r = await _state.api.saveIncidentReport(_id, {
        'kind': widget.kind,
        'category': _category,
        'occurredAt': _when.toUtc().toIso8601String(),
        'placeLabel': _place.text.trim().isEmpty ? null : _place.text.trim(),
        'description': _desc.text.trim(),
        'immediateRisk': _risk,
        'organisation': _org.text.trim().isEmpty ? null : _org.text.trim(),
        'details': <String, dynamic>{},
        'evidenceItemIds': <String>[],
        'route': _route,
        'submit': submit,
      });
      if (!mounted) return;
      showInfo(context, submit ? 'Saved. Reference ${r['reference'] ?? ''}' : 'Draft saved.');
      Navigator.pop(context);
    } catch (e) {
      if (mounted) showError(context, e);
    }
  }

  @override
  Widget build(BuildContext context) {
    final routes = widget.kind == 'workplace' ? const ['private', 'guardian', 'legal', 'organisation'] : const ['private', 'guardian', 'legal'];
    return Scaffold(
      appBar: AppBar(title: const Text('Report')),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : ListView(padding: const EdgeInsets.all(16), children: [
              if (_readOnly) const NoticeBox(text: 'This report is submitted and cannot be changed.'),
              if (widget.kind == 'false_accusation') const NoticeBox(text: 'This is your own record of events. It does not say anyone is guilty or innocent.'),
              const SizedBox(height: 8),
              TextField(controller: _desc, readOnly: _readOnly, maxLines: 6, maxLength: 3000, decoration: const InputDecoration(labelText: 'What happened')),
              TextField(controller: _place, readOnly: _readOnly, decoration: const InputDecoration(labelText: 'Where (optional)')),
              if (widget.kind == 'workplace') TextField(controller: _org, readOnly: _readOnly, decoration: const InputDecoration(labelText: 'Organisation')),
              ListTile(
                contentPadding: EdgeInsets.zero,
                title: const Text('When'),
                subtitle: Text(dateTime(_when)),
                trailing: const Icon(Icons.edit_calendar),
                onTap: _readOnly
                    ? null
                    : () async {
                        final d = await showDatePicker(context: context, initialDate: _when, firstDate: DateTime(2020), lastDate: DateTime.now());
                        if (d != null) setState(() => _when = DateTime(d.year, d.month, d.day, _when.hour, _when.minute));
                      },
              ),
              SwitchListTile(contentPadding: EdgeInsets.zero, title: const Text('I am in danger right now'), subtitle: const Text('Use SOS or call 112 first.'), value: _risk, onChanged: _readOnly ? null : (v) => setState(() => _risk = v)),
              const SectionLabel('Who can see this'),
              Wrap(spacing: 8, children: [
                for (final r in routes) PillChoice(label: p4Label(r), selected: _route == r, onSelected: (_) { if (!_readOnly) setState(() => _route = r); }),
              ]),
              const SizedBox(height: 16),
              if (!_readOnly) ...[
                BusyButton(label: 'Submit report', onPressed: () => _save(true)),
                const SizedBox(height: 8),
                OutlinedButton(onPressed: () => _save(false), child: const Text('Save draft')),
              ],
              const P4Disclaimer('Admins cannot read your report. This is not legal advice.'),
            ]),
    );
  }
}
