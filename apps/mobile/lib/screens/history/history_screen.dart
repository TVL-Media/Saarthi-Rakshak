import 'package:flutter/material.dart';

import '../../api/api_client.dart';
import '../../api/models.dart';
import '../../state/app_state.dart';
import '../../theme.dart';
import '../../widgets/common.dart';
import '../../widgets/format.dart';
import '../sos/recordings_screen.dart';

String historyTitle(HistoryItem i) {
  if (i.type == 'journey') return 'Journey to ${i.destinationLabel ?? 'destination'}';
  if (i.isTest) return 'Test SOS';
  if (i.status == 'cancelled') return 'SOS cancelled (false alarm)';
  return 'SOS';
}

String historyStatus(HistoryItem i) => switch (i.status) {
      'active' => 'Active now',
      'ended' => i.type == 'sos' ? (i.isTest ? 'Sent' : 'Ended safe') : 'Ended',
      'cancelled' => 'Cancelled in the countdown',
      'arrived' => 'Arrived safely',
      'lost_contact' => 'Lost contact',
      _ => i.status,
    };

/// Colour of a history item's status (red = SOS still active or contact lost, green = safe).
Color historyColor(HistoryItem i) => switch (i.status) {
      'active' || 'lost_contact' => AppColors.red,
      'ended' when i.type == 'sos' && !i.isTest => AppColors.green,
      'arrived' => AppColors.green,
      _ => AppColors.muted,
    };

/// The SOS (red) or journey (green) icon of a history item.
class HistoryIcon extends StatelessWidget {
  const HistoryIcon(this.item, {super.key, this.size = 44});
  final HistoryItem item;
  final double size;

  @override
  Widget build(BuildContext context) => item.type == 'sos'
      ? IconTile(Icons.sos, color: AppColors.red, background: AppColors.redSoft, size: size)
      : IconTile(Icons.route, color: AppColors.green, background: AppColors.greenSoft, size: size);
}

/// History tab: own SOS events and journeys, newest first, 20 at a time.
class HistoryScreen extends StatefulWidget {
  const HistoryScreen({super.key});

  @override
  State<HistoryScreen> createState() => _HistoryScreenState();
}

class _HistoryScreenState extends State<HistoryScreen> {
  String? _type;
  final _items = <HistoryItem>[];
  String? _cursor;
  bool _loading = false;
  bool _done = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _reload();
  }

  Future<void> _reload() async {
    _items.clear();
    _cursor = null;
    _done = false;
    await _more();
  }

  Future<void> _more() async {
    if (_loading || _done) return;
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final page = await AppScope.read(context).api.history(type: _type, cursor: _cursor);
      _items.addAll(page.items);
      _cursor = page.nextCursor;
      _done = page.nextCursor == null;
    } on ApiException catch (e) {
      _error = e.message;
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: RefreshIndicator(
        onRefresh: _reload,
        child: NotificationListener<ScrollNotification>(
          onNotification: (n) {
            if (n.metrics.pixels > n.metrics.maxScrollExtent - 300) _more();
            return false;
          },
          child: ListView(
            padding: const EdgeInsets.fromLTRB(20, 12, 20, 24),
            children: [
              const TabHeader('History'),
              Wrap(spacing: 8, children: [
                for (final (label, type) in [('All', null), ('SOS', 'sos'), ('Journeys', 'journey')])
                  ChoiceChip(
                    label: Text(label),
                    selected: _type == type,
                    selectedColor: AppColors.red,
                    backgroundColor: AppColors.cream,
                    side: BorderSide(color: _type == type ? AppColors.red : AppColors.line),
                    shape: const StadiumBorder(),
                    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
                    labelStyle: TextStyle(color: _type == type ? Colors.white : AppColors.ink, fontWeight: FontWeight.w600, fontSize: 15),
                    showCheckmark: false,
                    onSelected: (_) {
                      setState(() => _type = type);
                      _reload();
                    },
                  ),
              ]),
              const SizedBox(height: 16),
              for (final i in _items)
                Padding(
                  padding: const EdgeInsets.only(bottom: 10),
                  child: AppCard(
                    onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => HistoryDetailScreen(item: i))),
                    padding: const EdgeInsets.fromLTRB(14, 14, 12, 14),
                    child: Row(children: [
                      HistoryIcon(i),
                      const SizedBox(width: 14),
                      Expanded(
                        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                          Text(historyTitle(i),
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 16)),
                          const SizedBox(height: 3),
                          Text(dateTime(i.startedAt), style: const TextStyle(color: AppColors.muted, fontSize: 13.5)),
                          const SizedBox(height: 6),
                          StatusPill(historyStatus(i), color: historyColor(i)),
                        ]),
                      ),
                      const SizedBox(width: 8),
                      const Icon(Icons.chevron_right, color: Color(0xFF9CA3AF)),
                    ]),
                  ),
                ),
              if (_loading && _items.isEmpty)
                for (var k = 0; k < 4; k++)
                  Container(
                    height: 72,
                    margin: const EdgeInsets.only(bottom: 10),
                    decoration: BoxDecoration(color: Colors.white.withValues(alpha: 0.7), borderRadius: BorderRadius.circular(16)),
                  ),
              if (_loading && _items.isNotEmpty) const Center(child: Padding(padding: EdgeInsets.all(12), child: CircularProgressIndicator())),
              if (_error != null) Text(_error!, style: const TextStyle(color: AppColors.red)),
              if (!_loading && _items.isEmpty && _error == null)
                const EmptyState(icon: Icons.history, text: 'No SOS or journeys yet'),
            ],
          ),
        ),
      ),
    );
  }
}

/// Timeline of one SOS or journey; SOS audio clips can be played on this phone and kept.
class HistoryDetailScreen extends StatefulWidget {
  const HistoryDetailScreen({super.key, required this.item});
  final HistoryItem item;

  @override
  State<HistoryDetailScreen> createState() => _HistoryDetailScreenState();
}

class _HistoryDetailScreenState extends State<HistoryDetailScreen> {
  HistoryDetail? _detail;
  String? _playing;

  @override
  void initState() {
    super.initState();
    _engine; // looked up now, while the screen is open
    _load();
  }

  @override
  void dispose() {
    _engine.stopPlayback().catchError((_) {});
    super.dispose();
  }

  late final _engine = AppScope.read(context).engine;

  Future<void> _load() async {
    try {
      final d = await AppScope.read(context).api.historyDetail(widget.item.type, widget.item.id);
      if (mounted) setState(() => _detail = d);
    } catch (e) {
      if (mounted) showError(context, e);
    }
  }

  Future<void> _play(AudioClip c) async {
    final state = AppScope.read(context);
    try {
      if (_playing == c.id) {
        await state.engine.stopPlayback();
        setState(() => _playing = null);
        return;
      }
      setState(() => _playing = c.id);
      final bytes = await state.api.download(await state.api.clipPlayUrl(c.id));
      await state.engine.playEncrypted(bytes);
    } catch (e) {
      setState(() => _playing = null);
      if (mounted) {
        showInfo(context, e is ApiException ? e.message : 'This recording can only be played on the phone that recorded it.');
      }
    }
  }

  Future<void> _keep(AudioClip c) async {
    try {
      await AppScope.read(context).api.keepClip(c.id, !c.keep);
      await _load();
    } catch (e) {
      if (mounted) showError(context, e);
    }
  }

  @override
  Widget build(BuildContext context) {
    final d = _detail;
    return Scaffold(
      appBar: AppBar(title: Text(historyTitle(widget.item))),
      body: d == null
          ? const Center(child: CircularProgressIndicator())
          : ListView(
              padding: const EdgeInsets.fromLTRB(20, 8, 20, 24),
              children: [
                AppCard(
                  child: Row(children: [
                    HistoryIcon(d.item, size: 48),
                    const SizedBox(width: 14),
                    Expanded(
                      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                        Text(dateTime(d.item.startedAt), style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w700)),
                        const SizedBox(height: 6),
                        StatusPill(historyStatus(d.item), color: historyColor(d.item)),
                      ]),
                    ),
                  ]),
                ),
                const SizedBox(height: 20),
                if (d.timeline.isNotEmpty)
                  AppCard(
                    padding: const EdgeInsets.fromLTRB(16, 18, 16, 2),
                    child: Column(children: [
                      for (final (n, e) in d.timeline.indexed)
                        IntrinsicHeight(
                          child: Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                            SizedBox(
                              width: 70,
                              child: Padding(
                                padding: const EdgeInsets.only(right: 8),
                                child: FittedBox(
                                  fit: BoxFit.scaleDown,
                                  alignment: Alignment.topLeft,
                                  child: Text(clock(e.at),
                                      maxLines: 1,
                                      style: const TextStyle(color: AppColors.muted, fontSize: 13, height: 1.45)),
                                ),
                              ),
                            ),
                            SizedBox(
                              width: 12,
                              child: Column(children: [
                                Container(
                                  width: 12,
                                  height: 12,
                                  margin: const EdgeInsets.only(top: 3),
                                  decoration: BoxDecoration(
                                    color: n == 0 || n == d.timeline.length - 1 ? AppColors.red : Colors.white,
                                    shape: BoxShape.circle,
                                    border: Border.all(color: AppColors.red, width: 2.5),
                                  ),
                                ),
                                if (n < d.timeline.length - 1)
                                  Expanded(child: Container(width: 2, color: AppColors.redSoft)),
                              ]),
                            ),
                            const SizedBox(width: 14),
                            Expanded(
                              child: Padding(
                                padding: const EdgeInsets.only(bottom: 18),
                                child: Text(e.text, style: const TextStyle(fontSize: 15, height: 1.35)),
                              ),
                            ),
                          ]),
                        ),
                    ]),
                  ),
                if (d.item.type == 'sos' && !d.item.isTest) ...[
                  const SizedBox(height: 16),
                  OutlinedButton.icon(
                    key: const Key('phone-recordings'),
                    onPressed: () => Navigator.push(
                      context,
                      MaterialPageRoute(builder: (_) => RecordingsScreen(sosId: d.item.id)),
                    ),
                    icon: const Icon(Icons.headphones, color: AppColors.red),
                    label: const Text('Recordings on this phone'),
                  ),
                ],
                if (d.clips.isNotEmpty) ...[
                  const SizedBox(height: 20),
                  const SectionLabel('Audio recordings'),
                  for (final c in d.clips)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 8),
                      child: AppCard(
                        padding: const EdgeInsets.fromLTRB(6, 6, 8, 6),
                        child: Row(children: [
                          IconButton(
                            icon: Icon(_playing == c.id ? Icons.stop_circle : Icons.play_circle, color: AppColors.red, size: 40),
                            onPressed: () => _play(c),
                          ),
                          const SizedBox(width: 4),
                          Expanded(
                            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                              Text('${clock(c.recordedAt)} · ${c.durationS ?? 30} s', style: const TextStyle(fontWeight: FontWeight.w700)),
                              const SizedBox(height: 2),
                              Text(c.keep ? 'Kept' : 'Deleted on ${dateTime(c.deleteAfter)}', style: const TextStyle(color: AppColors.muted)),
                            ]),
                          ),
                          TextButton(
                            style: TextButton.styleFrom(foregroundColor: AppColors.red),
                            onPressed: () => _keep(c),
                            child: Text(c.keep ? 'Don’t keep' : 'Keep'),
                          ),
                        ]),
                      ),
                    ),
                  const SizedBox(height: 4),
                  const Text('Recordings play only on the phone that recorded them. Nobody else can listen.',
                      style: TextStyle(color: AppColors.muted, fontSize: 13.5, height: 1.4)),
                ],
              ],
            ),
    );
  }
}
