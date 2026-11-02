import 'package:flutter/material.dart';

import '../../api/api_client.dart';
import '../../api/models.dart';
import '../../state/app_state.dart';
import '../../theme.dart';
import '../../widgets/common.dart';
import '../../widgets/format.dart';

/// Trusted Guardians (design: "Trusted Guardian"). Setup step 1 of 2 and the Guardians tab.
class GuardiansScreen extends StatefulWidget {
  const GuardiansScreen({super.key, this.setupStep = false});
  final bool setupStep;

  @override
  State<GuardiansScreen> createState() => _GuardiansScreenState();
}

class _GuardiansScreenState extends State<GuardiansScreen> {
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _reload();
  }

  Future<void> _reload() async {
    try {
      await AppScope.read(context).refreshGuardians();
    } catch (e) {
      if (mounted) showError(context, e);
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _add() async {
    final added = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      backgroundColor: AppColors.cream,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(24))),
      builder: (_) => const _GuardianForm(),
    );
    if (added == true) {
      await _reload();
      if (mounted) showInfo(context, 'Invite sent by SMS.');
    }
  }

  Future<void> _edit(Guardian g) async {
    final saved = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      backgroundColor: AppColors.cream,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(24))),
      builder: (_) => _GuardianForm(existing: g),
    );
    if (saved == true) await _reload();
  }

  Future<void> _menu(Guardian g, String action) async {
    final state = AppScope.read(context);
    try {
      switch (action) {
        case 'edit':
          return await _edit(g);
        case 'resend':
          await state.api.resendInvite(g.id);
          if (mounted) showInfo(context, 'Invite sent again.');
        case 'remove':
          if (!await confirm(context, 'Remove ${g.name}?', '${g.name} will no longer get your alerts.', yes: 'Remove', danger: true)) {
            return;
          }
          await state.api.removeGuardian(g.id);
          await _reload();
      }
    } catch (e) {
      if (mounted) showError(context, e);
    }
  }

  @override
  Widget build(BuildContext context) {
    final state = AppScope.of(context);
    final list = state.guardians;
    final max = state.me?.rule('guardian.max_count', 5) ?? 5;
    final active = list.where((g) => g.status != 'declined').length;
    final accepted = list.where((g) => g.status == 'accepted').length;

    return Scaffold(
      appBar: AppBar(
        title: widget.setupStep ? const Text('Step 1 of 2') : null,
        automaticallyImplyLeading: !widget.setupStep && Navigator.canPop(context),
      ),
      body: RefreshIndicator(
        onRefresh: _reload,
        child: ListView(
          padding: const EdgeInsets.fromLTRB(20, 4, 20, 24),
          children: [
            const Text('Trusted Guardians', style: TextStyle(fontSize: 30, fontWeight: FontWeight.w800, height: 1.15, letterSpacing: -0.4)),
            const SizedBox(height: 8),
            const Text('People who can keep an eye on you and help when needed.',
                style: TextStyle(fontSize: 17, color: Color(0xFF374151), height: 1.35)),
            const SizedBox(height: 6),
            Text('$active/$max Guardians Added', style: const TextStyle(fontSize: 14, color: AppColors.muted, fontWeight: FontWeight.w500)),
            const SizedBox(height: 18),
            SizedBox(
              height: 56,
              child: FilledButton.icon(
                onPressed: active >= max ? null : _add,
                icon: const Icon(Icons.add, size: 24),
                label: Text(active >= max ? 'You have $max guardians' : 'Add Guardian'),
              ),
            ),
            const SizedBox(height: 10),
            if (_loading && list.isEmpty)
              const Padding(padding: EdgeInsets.all(32), child: Center(child: CircularProgressIndicator()))
            else if (list.isEmpty)
              const EmptyState(icon: Icons.group_add_outlined, text: 'Add someone you trust. They get an SMS invite and need no app.')
            else
              for (final g in list)
                _GuardianTile(guardian: g, onAction: (a) => _menu(g, a)),
            const SizedBox(height: 16),
            Container(
              padding: const EdgeInsets.fromLTRB(16, 18, 16, 18),
              decoration: BoxDecoration(color: const Color(0xFFFDECEC), borderRadius: BorderRadius.circular(18)),
              child: IntrinsicHeight(
                child: Row(children: [
                  const SizedBox(
                    width: 64,
                    child: Center(child: Icon(Icons.shield, color: AppColors.red, size: 52)),
                  ),
                  const SizedBox(width: 12),
                  Container(width: 1.5, color: AppColors.red.withValues(alpha: 0.5)),
                  const SizedBox(width: 14),
                  const Expanded(
                    child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Text('Guardians can', style: TextStyle(color: AppColors.red, fontWeight: FontWeight.w700, fontSize: 16.5)),
                      SizedBox(height: 6),
                      Text('View your live location during an SOS or journey\nReceive your SOS alerts by SMS\nGet notified if you miss a check-in',
                          style: TextStyle(height: 1.55, color: Color(0xFF4B5563), fontSize: 14.5)),
                    ]),
                  ),
                ]),
              ),
            ),
            if (widget.setupStep) ...[
              const SizedBox(height: 20),
              if (accepted == 0 && list.isNotEmpty)
                const Padding(
                  padding: EdgeInsets.only(bottom: 10),
                  child: Text('SOS alerts already reach guardians who have not answered yet. Journeys need at least one who accepted.',
                      style: TextStyle(color: AppColors.muted)),
                ),
              FilledButton(
                onPressed: list.isEmpty ? null : () => state.guardiansStepDone(),
                child: const Text('Continue'),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

class _GuardianTile extends StatelessWidget {
  const _GuardianTile({required this.guardian, required this.onAction});
  final Guardian guardian;
  final void Function(String) onAction;

  @override
  Widget build(BuildContext context) {
    final g = guardian;
    final (label, fg, bg) = switch (g.status) {
      'accepted' => ('Accepted', AppColors.green, AppColors.greenSoft),
      'declined' => ('Declined', AppColors.muted, const Color(0xFFEFEFEF)),
      _ => ('Invite sent', AppColors.amber, AppColors.amberSoft),
    };
    return Container(
      padding: const EdgeInsets.symmetric(vertical: 14),
      decoration: const BoxDecoration(border: Border(bottom: BorderSide(color: AppColors.line))),
      child: Row(children: [
        Initials(g.name, size: 58),
        const SizedBox(width: 14),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(g.name, style: const TextStyle(fontSize: 16.5, fontWeight: FontWeight.w700)),
            const SizedBox(height: 2),
            if (g.relation != null) Text(g.relation!, style: const TextStyle(color: Color(0xFF4B5563), fontSize: 14)),
            Text(g.phone != null ? prettyPhone(g.phone!) : (g.phoneMasked ?? 'Number deleted'),
                style: const TextStyle(color: Color(0xFF4B5563), fontSize: 14)),
          ]),
        ),
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
          decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(8)),
          child: Text(label, style: TextStyle(color: fg, fontWeight: FontWeight.w600, fontSize: 12.5)),
        ),
        PopupMenuButton<String>(
          icon: const Icon(Icons.more_vert, color: AppColors.ink),
          onSelected: onAction,
          itemBuilder: (_) => [
            const PopupMenuItem(value: 'edit', child: Text('Edit name or relation')),
            if (g.status == 'pending') const PopupMenuItem(value: 'resend', child: Text('Send invite again')),
            const PopupMenuItem(value: 'remove', child: Text('Remove')),
          ],
        ),
      ]),
    );
  }
}

class _GuardianForm extends StatefulWidget {
  const _GuardianForm({this.existing});
  final Guardian? existing;

  @override
  State<_GuardianForm> createState() => _GuardianFormState();
}

class _GuardianFormState extends State<_GuardianForm> {
  late final _name = TextEditingController(text: widget.existing?.name);
  final _phone = TextEditingController();
  late final _relation = TextEditingController(text: widget.existing?.relation);
  String? _error;

  @override
  void dispose() {
    _name.dispose();
    _phone.dispose();
    _relation.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    final api = AppScope.read(context).api;
    final name = _name.text.trim();
    if (name.isEmpty || name.length > 60) return setState(() => _error = 'Enter a name (up to 60 characters).');
    final relation = _relation.text.trim();
    if (relation.length > 40) return setState(() => _error = 'Relation can be at most 40 characters.');
    try {
      if (widget.existing == null) {
        final phone = normaliseIndianMobile(_phone.text);
        if (phone == null) return setState(() => _error = 'Enter a 10-digit Indian mobile number.');
        if (phone == AppScope.read(context).me?.phone) return setState(() => _error = 'You can’t add your own number.');
        await api.addGuardian(name, phone, relation);
      } else {
        await api.updateGuardian(widget.existing!.id, name: name, relation: relation);
      }
      if (mounted) Navigator.pop(context, true);
    } on ApiException catch (e) {
      setState(() => _error = e.message);
    }
  }

  @override
  Widget build(BuildContext context) {
    final editing = widget.existing != null;
    return Padding(
      padding: EdgeInsets.fromLTRB(20, 20, 20, 20 + MediaQuery.of(context).viewInsets.bottom),
      child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Text(editing ? 'Edit guardian' : 'Add a guardian', style: const TextStyle(fontSize: 22, fontWeight: FontWeight.w800)),
        const SizedBox(height: 16),
        TextField(
          controller: _name,
          textCapitalization: TextCapitalization.words,
          decoration: const InputDecoration(prefixIcon: Icon(Icons.person_outline), hintText: 'Name'),
        ),
        if (!editing) ...[
          const SizedBox(height: 12),
          TextField(
            controller: _phone,
            keyboardType: TextInputType.phone,
            decoration: const InputDecoration(prefixIcon: Icon(Icons.phone_outlined), prefixText: '+91  ', hintText: 'Mobile number'),
          ),
        ],
        const SizedBox(height: 12),
        TextField(
          controller: _relation,
          textCapitalization: TextCapitalization.sentences,
          decoration: const InputDecoration(prefixIcon: Icon(Icons.favorite_border), hintText: 'Relation, e.g. Brother (optional)'),
        ),
        if (_error != null) ...[
          const SizedBox(height: 10),
          Text(_error!, style: const TextStyle(color: AppColors.red, fontWeight: FontWeight.w500)),
        ],
        const SizedBox(height: 18),
        BusyButton(label: editing ? 'Save' : 'Send invite', onPressed: _save),
        if (!editing)
          const Padding(
            padding: EdgeInsets.only(top: 10),
            child: Text('They get an SMS with a link to accept. No app needed.', textAlign: TextAlign.center, style: TextStyle(color: AppColors.muted)),
          ),
      ]),
    );
  }
}
