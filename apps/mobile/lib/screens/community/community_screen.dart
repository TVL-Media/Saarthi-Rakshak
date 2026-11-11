import 'dart:io';

import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';
import 'package:uuid/uuid.dart';

import '../../api/api_client.dart';
import '../../api/phase2_api.dart';
import '../../state/app_state.dart';
import '../../theme.dart';
import '../../widgets/common.dart';
import '../../widgets/format.dart';
import '../settings/settings_screen.dart' show ReportProblemScreen;

const postCategories = {
  'lighting': ('Poor lighting', Icons.lightbulb_outline),
  'unsafe_spot': ('Unsafe spot', Icons.warning_amber_outlined),
  'harassment_area': ('Harassment reported', Icons.report_outlined),
  'road': ('Road problem', Icons.add_road),
  'other': ('Other', Icons.info_outline),
};

/// Community safety (feature 22): reports from people in Noida, shown after an admin checks them.
class CommunityScreen extends StatefulWidget {
  const CommunityScreen({super.key});

  @override
  State<CommunityScreen> createState() => _CommunityScreenState();
}

class _CommunityScreenState extends State<CommunityScreen> {
  late final AppState _state = AppScope.read(context);
  String? _area;
  List<String> _areas = const [];
  List<CommunityPost>? _posts;
  String? _error;

  @override
  void initState() {
    super.initState();
    _state.api.communityAreas().then((a) {
      if (mounted) setState(() => _areas = a);
    }).catchError((_) {});
    _load();
  }

  Future<void> _load() async {
    try {
      final p = await _state.api.communityPosts(_area);
      if (mounted) {
        setState(() {
          _posts = p;
          _error = null;
        });
      }
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } catch (_) {
      if (mounted) setState(() => _error = 'Could not load reports. Pull down to try again.');
    }
  }

  Future<void> _pickArea() async {
    final a = await pickArea(context, _areas, allowAll: true);
    if (a == null) return;
    setState(() {
      _area = a.isEmpty ? null : a;
      _posts = null;
    });
    await _load();
  }

  Future<void> _flag(CommunityPost p) async {
    final c = TextEditingController();
    final reason = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Report this post'),
        content: TextField(controller: c, maxLength: 300, maxLines: 3, decoration: const InputDecoration(hintText: 'What is wrong with it?')),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')),
          FilledButton(
            style: FilledButton.styleFrom(minimumSize: const Size(0, 44)),
            onPressed: () => Navigator.pop(ctx, c.text.trim()),
            child: const Text('Report'),
          ),
        ],
      ),
    );
    if (reason == null || reason.length < 3) return;
    try {
      await _state.api.flagPost(p.id, reason);
      if (mounted) showInfo(context, 'Thanks. Our team will check this post.');
    } catch (e) {
      if (mounted) showError(context, e);
    }
  }

  Future<void> _go(Widget w) async {
    await Navigator.push(context, MaterialPageRoute(builder: (_) => w));
    await _load();
  }

  @override
  Widget build(BuildContext context) {
    final posts = _posts;
    return Scaffold(
      appBar: AppBar(
        title: const Text('Community safety'),
        actions: [IconButton(tooltip: 'My reports', icon: const Icon(Icons.history), onPressed: () => _go(const MyReportsScreen()))],
      ),
      body: RefreshIndicator(
        onRefresh: _load,
        child: ListView(padding: const EdgeInsets.fromLTRB(20, 8, 20, 32), children: [
          AppCard(
            onTap: _pickArea,
            padding: const EdgeInsets.fromLTRB(16, 12, 12, 12),
            child: Row(children: [
              const Icon(Icons.place_outlined, color: AppColors.red),
              const SizedBox(width: 12),
              Expanded(child: Text(_area ?? 'All of Noida', style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w700))),
              const Icon(Icons.expand_more, color: AppColors.muted),
            ]),
          ),
          const SizedBox(height: 12),
          FilledButton.icon(
            key: const Key('community-report'),
            onPressed: () => _go(CommunityReportScreen(areas: _areas)),
            icon: const Icon(Icons.add),
            label: const Text('Report a safety issue'),
          ),
          const SizedBox(height: 16),
          if (_error != null) NoticeBox(text: _error!, icon: Icons.error_outline, color: AppColors.red, background: AppColors.redSoft),
          if (posts == null && _error == null) const Padding(padding: EdgeInsets.all(40), child: Center(child: CircularProgressIndicator())),
          if (posts != null && posts.isEmpty)
            const AppCard(child: EmptyState(icon: Icons.groups_outlined, text: 'No reports for this area yet.')),
          if (posts != null)
            for (final p in posts) Padding(padding: const EdgeInsets.only(bottom: 12), child: PostCard(post: p, onFlag: () => _flag(p))),
          const SizedBox(height: 8),
          Text.rich(
            TextSpan(children: [
              const TextSpan(text: 'Reports are checked by our team before they appear. To complain about a post, report it or contact our grievance officer through '),
              WidgetSpan(
                alignment: PlaceholderAlignment.baseline,
                baseline: TextBaseline.alphabetic,
                child: GestureDetector(
                  onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => const ReportProblemScreen())),
                  child: const Text('Help & Support', style: TextStyle(color: AppColors.red, fontWeight: FontWeight.w600, fontSize: 13)),
                ),
              ),
              const TextSpan(text: '.'),
            ]),
            style: const TextStyle(color: AppColors.muted, fontSize: 13, height: 1.4),
          ),
        ]),
      ),
    );
  }
}

class PostCard extends StatelessWidget {
  const PostCard({super.key, required this.post, this.onFlag});
  final CommunityPost post;
  final VoidCallback? onFlag;

  @override
  Widget build(BuildContext context) {
    final cat = postCategories[post.category] ?? postCategories['other']!;
    return AppCard(
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          IconTile(cat.$2, size: 36),
          const SizedBox(width: 10),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(cat.$1, style: const TextStyle(fontWeight: FontWeight.w700)),
              Text('${post.area} · ${ago(post.createdAt)}', style: const TextStyle(color: AppColors.muted, fontSize: 13)),
            ]),
          ),
          if (post.official) const StatusPill('Official', color: AppColors.green),
          if (post.status != null) _statusPill(post.status!),
          if (onFlag != null && !post.official)
            IconButton(tooltip: 'Report this post', icon: const Icon(Icons.flag_outlined, color: AppColors.muted, size: 20), onPressed: onFlag),
        ]),
        const SizedBox(height: 10),
        Text(post.body, style: const TextStyle(fontSize: 15, height: 1.45)),
        if (post.photoUrl != null) ...[
          const SizedBox(height: 10),
          ClipRRect(
            borderRadius: BorderRadius.circular(12),
            child: Image.network(post.photoUrl!, height: 180, width: double.infinity, fit: BoxFit.cover, errorBuilder: (_, _, _) => const SizedBox.shrink()),
          ),
        ],
        if (post.reason != null && post.status != 'published') ...[
          const SizedBox(height: 8),
          Text('Reason: ${post.reason}', style: const TextStyle(color: AppColors.red, fontSize: 13.5)),
        ],
      ]),
    );
  }

  Widget _statusPill(String s) => switch (s) {
        'published' => const StatusPill('Published', color: AppColors.green),
        'pending' => const StatusPill('Being checked', color: AppColors.amber),
        'rejected' => const StatusPill('Not published', color: AppColors.red),
        _ => const StatusPill('Removed', color: AppColors.muted),
      };
}

/// Area picker (Noida sectors). Returns '' for "All of Noida" when [allowAll].
Future<String?> pickArea(BuildContext context, List<String> areas, {bool allowAll = false}) => showModalBottomSheet<String>(
      context: context,
      isScrollControlled: true,
      backgroundColor: AppColors.cream,
      builder: (ctx) => _AreaSheet(areas: areas, allowAll: allowAll),
    );

class _AreaSheet extends StatefulWidget {
  const _AreaSheet({required this.areas, required this.allowAll});
  final List<String> areas;
  final bool allowAll;

  @override
  State<_AreaSheet> createState() => _AreaSheetState();
}

class _AreaSheetState extends State<_AreaSheet> {
  String _q = '';

  @override
  Widget build(BuildContext context) {
    final list = widget.areas.where((a) => a.toLowerCase().contains(_q.toLowerCase())).toList();
    return SafeArea(
      child: SizedBox(
        height: MediaQuery.of(context).size.height * 0.75,
        child: Padding(
          padding: EdgeInsets.fromLTRB(20, 16, 20, MediaQuery.of(context).viewInsets.bottom),
          child: Column(children: [
            TextField(
              autofocus: false,
              onChanged: (v) => setState(() => _q = v),
              decoration: const InputDecoration(prefixIcon: Icon(Icons.search), hintText: 'Search sector or area'),
            ),
            const SizedBox(height: 8),
            Expanded(
              child: ListView(children: [
                if (widget.allowAll && _q.isEmpty) ListTile(title: const Text('All of Noida'), onTap: () => Navigator.pop(context, '')),
                for (final a in list) ListTile(title: Text(a), onTap: () => Navigator.pop(context, a)),
                if (list.isEmpty && _q.trim().length >= 2)
                  ListTile(
                    leading: const Icon(Icons.add),
                    title: Text('Use "${_q.trim()}"'),
                    onTap: () => Navigator.pop(context, _q.trim()),
                  ),
              ]),
            ),
          ]),
        ),
      ),
    );
  }
}

class CommunityReportScreen extends StatefulWidget {
  const CommunityReportScreen({super.key, required this.areas});
  final List<String> areas;

  @override
  State<CommunityReportScreen> createState() => _CommunityReportScreenState();
}

class _CommunityReportScreenState extends State<CommunityReportScreen> {
  String _category = 'unsafe_spot';
  String? _area;
  final _body = TextEditingController();
  XFile? _photo;
  String? _error;

  @override
  void dispose() {
    _body.dispose();
    super.dispose();
  }

  Future<void> _pickPhoto() async {
    final f = await ImagePicker().pickImage(source: ImageSource.camera, maxWidth: 1280, maxHeight: 1280, imageQuality: 75);
    if (f != null) setState(() => _photo = f);
  }

  Future<void> _send() async {
    if (_area == null) {
      setState(() => _error = 'Choose the area.');
      return;
    }
    final state = AppScope.read(context);
    try {
      String? photoKey;
      if (_photo != null) {
        final size = await File(_photo!.path).length();
        if (size > 1024 * 1024) {
          setState(() => _error = 'The photo is too large. Take it again.');
          return;
        }
        final link = await state.api.communityPhotoLink(size);
        await state.api.uploadFile(link, _photo!.path);
        photoKey = link.key;
      }
      await state.api.communityReport({
        'id': const Uuid().v4(),
        'category': _category,
        'area': _area,
        'body': _body.text.trim(),
        'photoKey': ?photoKey,
      });
      if (mounted) {
        showInfo(context, 'Thanks. Your report will appear after our team checks it.');
        Navigator.pop(context);
      }
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: const Text('Report a safety issue')),
        body: ListView(padding: const EdgeInsets.fromLTRB(20, 8, 20, 32), children: [
          const SectionLabel('What is it?'),
          Wrap(spacing: 8, runSpacing: 8, children: [
            for (final e in postCategories.entries)
              PillChoice(
                icon: e.value.$2,
                label: e.value.$1,
                selected: _category == e.key,
                onSelected: (_) => setState(() => _category = e.key),
              ),
          ]),
          const SizedBox(height: 16),
          AppCard(
            padding: EdgeInsets.zero,
            child: MenuRow(
              icon: Icons.place_outlined,
              accent: true,
              title: _area ?? 'Choose area',
              subtitle: _area == null ? 'Sector or area in Noida' : null,
              onTap: () async {
                final a = await pickArea(context, widget.areas);
                if (a != null && a.isNotEmpty) setState(() => _area = a);
              },
            ),
          ),
          const SizedBox(height: 16),
          TextField(
            key: const Key('report-body'),
            controller: _body,
            minLines: 4,
            maxLines: 8,
            maxLength: 500,
            decoration: const InputDecoration(labelText: 'What is the problem?', hintText: 'e.g. The street light near the park gate has not worked for a week.'),
          ),
          const Text('Do not write names, phone numbers or emails.', style: TextStyle(color: AppColors.muted, fontSize: 13)),
          const SizedBox(height: 16),
          if (_photo == null)
            OutlinedButton.icon(onPressed: _pickPhoto, icon: const Icon(Icons.photo_camera_outlined), label: const Text('Add a photo (optional)'))
          else
            Stack(children: [
              ClipRRect(borderRadius: BorderRadius.circular(12), child: Image.file(File(_photo!.path), height: 180, width: double.infinity, fit: BoxFit.cover)),
              Positioned(
                right: 8,
                top: 8,
                child: RoundIconButton(icon: Icons.close, tooltip: 'Remove photo', onPressed: () => setState(() => _photo = null)),
              ),
            ]),
          const SizedBox(height: 8),
          const Text('Do not include faces or number plates. Our team may blur or remove the photo.',
              style: TextStyle(color: AppColors.muted, fontSize: 13)),
          if (_error != null) Padding(padding: const EdgeInsets.only(top: 12), child: Text(_error!, style: const TextStyle(color: AppColors.red))),
          const SizedBox(height: 20),
          BusyButton(label: 'Send report', onPressed: _send),
        ]),
      );
}

class MyReportsScreen extends StatelessWidget {
  const MyReportsScreen({super.key});

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: const Text('My reports')),
        body: FutureBuilder<List<CommunityPost>>(
          future: AppScope.read(context).api.myCommunityReports(),
          builder: (context, snap) {
            if (snap.hasError) return const Center(child: Text('Could not load your reports.'));
            if (!snap.hasData) return const Center(child: CircularProgressIndicator());
            final list = snap.data!;
            return ListView(padding: const EdgeInsets.fromLTRB(20, 8, 20, 32), children: [
              if (list.isEmpty) const AppCard(child: EmptyState(icon: Icons.inbox_outlined, text: 'You have not sent a report yet.')),
              for (final p in list) Padding(padding: const EdgeInsets.only(bottom: 12), child: PostCard(post: p)),
            ]);
          },
        ),
      );
}
