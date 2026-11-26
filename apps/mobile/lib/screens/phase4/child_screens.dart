import 'dart:async';

import 'package:flutter/material.dart';

import '../../api/phase4_api.dart';
import '../../state/app_state.dart';
import '../../theme.dart';
import '../../widgets/common.dart';
import '../../widgets/format.dart';
import '../sos/sos_countdown_screen.dart';
import 'phase4_common.dart';

void _push(BuildContext c, Widget w) => Navigator.push(c, MaterialPageRoute(builder: (_) => w));

/// Child Safety hub: a parent watches over linked children; a child accepts a link and shares location.
class ChildSafetyScreen extends StatelessWidget {
  const ChildSafetyScreen({super.key});
  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: const Text('Child Safety')),
        body: ListView(padding: const EdgeInsets.all(16), children: [
          MenuGroup(children: [
            MenuRow(icon: Icons.family_restroom, title: "I'm a parent", subtitle: 'Link a child, set places, see alerts', accent: true, onTap: () => _push(context, const ParentScreen())),
            MenuRow(icon: Icons.child_care, title: "I'm the child", subtitle: 'Accept a link from your parent', accent: true, onTap: () => _push(context, const ChildModeScreen())),
          ]),
          const NoticeBox(text: 'A child is only linked after they accept on their own phone. Either side can end the link at any time. Locations can be late or approximate and are never a guarantee.'),
        ]),
      );
}

class ParentScreen extends StatefulWidget {
  const ParentScreen({super.key});
  @override
  State<ParentScreen> createState() => _ParentScreenState();
}

class _ParentScreenState extends State<ParentScreen> {
  late final AppState _state = AppScope.read(context);
  Key _k = UniqueKey();

  Future<void> _add() async {
    final name = TextEditingController();
    final phone = TextEditingController(text: '+91');
    final ok = await showDialog<bool>(
      context: context,
      builder: (c) => AlertDialog(
        title: const Text('Link a child'),
        content: Column(mainAxisSize: MainAxisSize.min, children: [
          TextField(controller: name, decoration: const InputDecoration(labelText: 'Child name')),
          TextField(controller: phone, keyboardType: TextInputType.phone, decoration: const InputDecoration(labelText: 'Child phone, with +91')),
          const SizedBox(height: 8),
          const Text('Your child will get a request and must accept it on their phone.', style: TextStyle(fontSize: 13, color: AppColors.muted)),
        ]),
        actions: [TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('Cancel')), FilledButton(onPressed: () => Navigator.pop(c, true), child: const Text('Send request'))],
      ),
    );
    if (ok != true) return;
    try {
      await _state.api.createChildLink(_state.newId(), name.text.trim(), phone.text.trim());
      if (mounted) setState(() => _k = UniqueKey());
    } catch (e) {
      if (mounted) showError(context, e);
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: const Text('My children')),
        floatingActionButton: FloatingActionButton.extended(onPressed: _add, icon: const Icon(Icons.person_add), label: const Text('Link a child')),
        body: P4Loader(
          key: _k,
          load: () => _state.api.childLinks(),
          builder: (c, items, reload) => RefreshIndicator(
            onRefresh: reload,
            child: ListView(padding: const EdgeInsets.fromLTRB(16, 16, 16, 90), children: [
              if (items.isEmpty) const EmptyState(icon: Icons.child_care, text: 'No children linked yet.'),
              for (final l in items)
                Padding(
                  padding: const EdgeInsets.only(bottom: 10),
                  child: AppCard(
                    onTap: () async {
                      await Navigator.push(context, MaterialPageRoute(builder: (_) => ChildDetailScreen(link: l)));
                      if (mounted) setState(() => _k = UniqueKey());
                    },
                    child: Row(children: [
                      Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                        Text('${l['childName']}', style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w700)),
                        Text('Phone ending ${l['childPhoneLast4']}', style: const TextStyle(color: AppColors.muted)),
                      ])),
                      if ((l['unseenAlerts'] as num? ?? 0) > 0) StatusPill('${l['unseenAlerts']} alert(s)', color: AppColors.red),
                      const SizedBox(width: 6),
                      StatusPill(p4Label('${l['status']}')),
                    ]),
                  ),
                ),
            ]),
          ),
        ),
      );
}

class ChildDetailScreen extends StatefulWidget {
  const ChildDetailScreen({super.key, required this.link});
  final Map<String, dynamic> link;
  @override
  State<ChildDetailScreen> createState() => _ChildDetailScreenState();
}

class _ChildDetailScreenState extends State<ChildDetailScreen> {
  late final AppState _state = AppScope.read(context);
  late final String _id = '${widget.link['id']}';
  Key _k = UniqueKey();

  void _refresh() => setState(() => _k = UniqueKey());

  Future<void> _addZone() async {
    final name = TextEditingController();
    final (pos, problem) = await p4Position();
    if (!mounted) return;
    if (pos == null) return showInfo(context, problem ?? 'Location not available.');
    final ok = await showDialog<bool>(
      context: context,
      builder: (c) => AlertDialog(
        title: const Text('Add a place here'),
        content: Column(mainAxisSize: MainAxisSize.min, children: [
          TextField(controller: name, decoration: const InputDecoration(labelText: 'Name, e.g. School')),
          const SizedBox(height: 8),
          const Text('Uses your current position with a 200 m circle.', style: TextStyle(fontSize: 13, color: AppColors.muted)),
        ]),
        actions: [TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('Cancel')), FilledButton(onPressed: () => Navigator.pop(c, true), child: const Text('Save'))],
      ),
    );
    if (ok != true || name.text.trim().isEmpty) return;
    try {
      await _state.api.saveChildZone(_id, _state.newId(), {'name': name.text.trim(), 'kind': 'other', 'lat': pos.latitude, 'lng': pos.longitude, 'radiusM': 200});
      _refresh();
    } catch (e) {
      if (mounted) showError(context, e);
    }
  }

  @override
  Widget build(BuildContext context) {
    final linkActive = widget.link['status'] == 'active';
    return Scaffold(
      appBar: AppBar(title: Text('${widget.link['childName']}')),
      body: P4Loader(
        key: _k,
        load: () async {
          final links = await _state.api.childLinks();
          final link = links.firstWhere((l) => l['id'] == _id, orElse: () => widget.link);
          if (link['status'] != 'active') return (link, <Map<String, dynamic>>[], <Map<String, dynamic>>[]);
          return (link, await _state.api.childZones(_id), await _state.api.childAlerts(_id));
        },
        builder: (c, d, reload) {
          final (link, zones, alerts) = d;
          final last = link['lastLocation'] as Map<String, dynamic>?;
          return ListView(padding: const EdgeInsets.all(16), children: [
            StatusPill(p4Label('${link['status']}')),
            if (link['status'] == 'invited') const Padding(padding: EdgeInsets.only(top: 8), child: NoticeBox(text: 'Waiting for your child to accept on their phone.')),
            if (link['status'] == 'active') ...[
              const SectionLabel('Last known location'),
              AppCard(
                child: last == null
                    ? const Text('No location received yet.')
                    : Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                        Text('Updated ${ago(DateTime.parse(last['recordedAt'] as String))}', style: const TextStyle(fontWeight: FontWeight.w700)),
                        if (last['stale'] == true) const Text('This is old. Do not treat it as where they are now.', style: TextStyle(color: AppColors.red)),
                        if (last['approximate'] == true) const Text('Approximate: the phone had weak GPS.', style: TextStyle(color: AppColors.muted)),
                        const SizedBox(height: 8),
                        OutlinedButton.icon(onPressed: () => p4Directions(context, (last['lat'] as num).toDouble(), (last['lng'] as num).toDouble()), icon: const Icon(Icons.map), label: const Text('Open in maps')),
                      ]),
              ),
              const SizedBox(height: 12),
              SectionLabel('Alerts (${alerts.length})'),
              if (alerts.isEmpty) const Text('No alerts.', style: TextStyle(color: AppColors.muted)),
              for (final a in alerts)
                ListTile(
                  contentPadding: EdgeInsets.zero,
                  leading: Icon(a['acknowledged'] == true ? Icons.check_circle_outline : Icons.warning_amber_rounded, color: a['acknowledged'] == true ? AppColors.muted : AppColors.red),
                  title: Text('${a['title']}'),
                  subtitle: Text(a['approximate'] == true ? '${a['createdAt']} · approximate' : '${a['createdAt']}'),
                  trailing: a['acknowledged'] == true ? null : TextButton(onPressed: () async { try { await _state.api.acknowledgeChildAlert('${a['id']}'); _refresh(); } catch (e) { if (context.mounted) showError(context, e); } }, child: const Text('Got it')),
                ),
              const SizedBox(height: 12),
              const SectionLabel('Places'),
              for (final z in zones)
                ListTile(
                  contentPadding: EdgeInsets.zero,
                  leading: const Icon(Icons.place_outlined),
                  title: Text('${z['name']}'),
                  subtitle: Text('${z['radiusM']} m${z['inside'] == true ? ' · child is inside' : ''}'),
                  trailing: IconButton(icon: const Icon(Icons.delete_outline), onPressed: () async { try { await _state.api.deleteChildZone(_id, '${z['id']}'); _refresh(); } catch (e) { if (context.mounted) showError(context, e); } }),
                ),
              OutlinedButton.icon(onPressed: _addZone, icon: const Icon(Icons.add_location_alt_outlined), label: const Text('Add a place at my position')),
            ],
            const SizedBox(height: 20),
            if (linkActive || link['status'] == 'invited')
              TextButton(
                onPressed: () async {
                  if (!await confirm(context, 'End this link?', 'You will no longer see this child\'s location or alerts.', yes: 'End link', danger: true)) return;
                  try {
                    await _state.api.revokeChildLink(_id);
                    if (context.mounted) Navigator.pop(context);
                  } catch (e) {
                    if (context.mounted) showError(context, e);
                  }
                },
                child: const Text('End link', style: TextStyle(color: AppColors.red)),
              ),
            const P4Disclaimer('Alerts depend on the child phone\'s signal and battery. They are not a guarantee of safety.'),
          ]);
        },
      ),
    );
  }
}

/// Child mode: accept a link, a big SOS, and (while this screen is open and sharing is on) post location.
class ChildModeScreen extends StatefulWidget {
  const ChildModeScreen({super.key});
  @override
  State<ChildModeScreen> createState() => _ChildModeScreenState();
}

class _ChildModeScreenState extends State<ChildModeScreen> {
  late final AppState _state = AppScope.read(context);
  Key _k = UniqueKey();
  Timer? _timer;

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  Future<void> _post() async {
    final (pos, _) = await p4Position();
    if (pos == null) return;
    try {
      await _state.api.postChildLocation(pos.latitude, pos.longitude, pos.accuracy, pos.timestamp);
    } catch (_) {}
  }

  void _syncTimer(bool sharing) {
    if (sharing && _timer == null) {
      _post();
      _timer = Timer.periodic(const Duration(minutes: 2), (_) => _post());
    } else if (!sharing) {
      _timer?.cancel();
      _timer = null;
    }
  }

  Future<void> _answer(String id, bool accept) async {
    try {
      await _state.api.answerChildInvitation(id, accept);
      if (mounted) setState(() => _k = UniqueKey());
    } catch (e) {
      if (mounted) showError(context, e);
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: const Text('Child mode')),
        body: P4Loader(
          key: _k,
          load: () => _state.api.childInvitations(),
          builder: (c, d, reload) {
            final invites = ((d['invitations'] as List?) ?? const []).cast<Map>();
            final parents = ((d['linkedParents'] as List?) ?? const []).cast<Map>();
            WidgetsBinding.instance.addPostFrameCallback((_) => _syncTimer(d['sharing'] == true));
            return ListView(padding: const EdgeInsets.all(16), children: [
              SizedBox(
                height: 90,
                child: FilledButton.icon(
                  style: FilledButton.styleFrom(backgroundColor: AppColors.red, textStyle: const TextStyle(fontSize: 24, fontWeight: FontWeight.w800)),
                  icon: const Icon(Icons.sos, size: 34),
                  label: const Text('SOS'),
                  onPressed: () => _push(context, const SosCountdownScreen(trigger: 'button')),
                ),
              ),
              const SizedBox(height: 16),
              for (final i in invites)
                Padding(
                  padding: const EdgeInsets.only(bottom: 10),
                  child: AppCard(
                    child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Text('${i['parentName']} wants to see where you are.', style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 16)),
                      const Text('If you accept, your location is shared with them. You can stop any time.'),
                      const SizedBox(height: 8),
                      Row(children: [
                        FilledButton(onPressed: () => _answer('${i['id']}', true), child: const Text('Accept')),
                        const SizedBox(width: 8),
                        OutlinedButton(onPressed: () => _answer('${i['id']}', false), child: const Text('Decline')),
                      ]),
                    ]),
                  ),
                ),
              if (parents.isNotEmpty) ...[
                const NoticeBox(icon: Icons.visibility_outlined, text: 'Your location is being shared with your linked parent while this screen is open.'),
                for (final p in parents) ListTile(leading: const Icon(Icons.family_restroom), title: Text('${p['parentName']}')),
              ],
              if (invites.isEmpty && parents.isEmpty) const EmptyState(icon: Icons.child_care, text: 'No link requests.'),
              const P4Disclaimer('Sarthi Rakshak alerts your guardians and helps you call 112. It is not a 24/7 monitoring service.'),
            ]);
          },
        ),
      );
}
