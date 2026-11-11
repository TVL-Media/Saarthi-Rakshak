import 'package:flutter/material.dart';
import 'package:google_maps_flutter/google_maps_flutter.dart';
import 'package:intl/intl.dart';
import 'package:permission_handler/permission_handler.dart';

import '../../api/api_client.dart';
import '../../api/maps_service.dart';
import '../../api/phase2_api.dart';
import '../../config.dart';
import '../../state/app_state.dart';
import '../../state/vault_session.dart';
import '../../theme.dart';
import '../../widgets/common.dart';
import '../../widgets/format.dart';
import '../vault/report_pdf.dart';

/// Must match DAILY_CONSENT_VERSION on the server (a new version asks for consent again).
const dailyConsentVersion = '2026-11';

/// Settings → Full-day location (features 6–8): on/off, pause, how long to keep, delete.
class DailyLocationScreen extends StatefulWidget {
  const DailyLocationScreen({super.key});

  @override
  State<DailyLocationScreen> createState() => _DailyLocationScreenState();
}

class _DailyLocationScreenState extends State<DailyLocationScreen> {
  late final AppState _state = AppScope.read(context);

  Future<void> _save(Map<String, Object?> change) async {
    try {
      await _state.saveDaily(change);
    } on ApiException catch (e) {
      if (mounted) showInfo(context, e.message);
    } catch (e) {
      if (mounted) showError(context, e);
    }
  }

  Future<void> _turnOn() async {
    final accepted = _state.daily.consentVersion == dailyConsentVersion ||
        (await Navigator.push<bool>(context, MaterialPageRoute(builder: (_) => const DailyConsentScreen())) ?? false);
    if (!accepted || !mounted) return;
    // "Allow all the time" is needed for the day to be recorded with the app closed.
    if (!await Permission.locationWhenInUse.request().isGranted) {
      if (mounted) showInfo(context, 'Allow location to use full-day location.');
      return;
    }
    if (!await Permission.locationAlways.isGranted) {
      if (!mounted) return;
      final go = await confirm(context, 'Allow all the time',
          'On the next screen choose "Allow all the time". Without it, your day is only recorded while the app is open.',
          yes: 'Continue');
      if (go) await Permission.locationAlways.request();
    }
    await Permission.activityRecognition.request();
    await _save({'enabled': true, 'consentVersion': dailyConsentVersion});
  }

  Future<void> _pause() async {
    final hours = await showModalBottomSheet<int>(
      context: context,
      backgroundColor: AppColors.cream,
      builder: (ctx) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(20, 16, 20, 16),
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            const Text('Pause for', style: TextStyle(fontSize: 20, fontWeight: FontWeight.w800)),
            const SizedBox(height: 12),
            MenuGroup(children: [
              for (final h in const [1, 4, 8, 24])
                MenuRow(icon: Icons.pause_circle_outline, title: h == 24 ? '1 day' : '$h hour${h == 1 ? '' : 's'}', onTap: () => Navigator.pop(ctx, h)),
            ]),
          ]),
        ),
      ),
    );
    if (hours == null) return;
    await _save({'pausedUntil': DateTime.now().add(Duration(hours: hours)).toUtc().toIso8601String()});
  }

  Future<void> _deleteAll() async {
    if (!await confirm(context, 'Delete all location history?', 'Every day recorded so far is deleted for good.', yes: 'Delete', danger: true)) return;
    try {
      await _state.api.deleteAllDaily();
      await _state.engine.dailyClear().catchError((_) {});
      if (mounted) showInfo(context, 'Location history deleted.');
    } catch (e) {
      if (mounted) showError(context, e);
    }
  }

  @override
  Widget build(BuildContext context) {
    final state = AppScope.of(context);
    final d = state.daily;
    final es = state.engineState;
    final status = !d.enabled
        ? 'Off'
        : d.paused
            ? 'Paused until ${clock(d.pausedUntil!)}'
            : (es.dailyActive ? 'Recording your day' : 'On (waiting: battery low or location not allowed all the time)');
    return Scaffold(
      appBar: AppBar(title: const Text('Full-day location')),
      body: ListView(padding: const EdgeInsets.fromLTRB(20, 8, 20, 32), children: [
        const Text('Keep a private record of where you went today, even without a journey. Only you can see it. Your guardians do not get it unless you start an SOS.',
            style: TextStyle(color: AppColors.muted, fontSize: 15, height: 1.4)),
        const SizedBox(height: 16),
        AppCard(
          padding: EdgeInsets.zero,
          child: SwitchListTile(
            key: const Key('daily-switch'),
            secondary: IconTile(Icons.my_location, size: 40, color: d.enabled ? AppColors.green : AppColors.red),
            title: const Text('Full-day location', style: TextStyle(fontWeight: FontWeight.w600)),
            subtitle: Text(status),
            value: d.enabled,
            onChanged: (v) => v ? _turnOn() : _save({'enabled': false}),
          ),
        ),
        const SizedBox(height: 16),
        if (d.enabled)
          MenuGroup(children: [
            if (d.paused)
              MenuRow(icon: Icons.play_circle_outline, title: 'Resume now', onTap: () => _save({'pausedUntil': null}))
            else
              MenuRow(icon: Icons.pause_circle_outline, title: 'Pause', subtitle: 'Stop recording for a while', onTap: _pause),
          ]),
        MenuGroup(label: 'Your history', children: [
          MenuRow(
            icon: Icons.timeline,
            accent: true,
            title: 'My timeline',
            subtitle: 'Where you went, day by day',
            onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => const TimelineScreen())),
          ),
        ]),
        const SectionLabel('Keep my history for'),
        SizedBox(
          width: double.infinity,
          child: SegmentedButton<int>(
            showSelectedIcon: false,
            segments: const [
              ButtonSegment(value: 7, label: Text('7 days')),
              ButtonSegment(value: 30, label: Text('30 days')),
              ButtonSegment(value: 90, label: Text('90 days')),
            ],
            selected: {d.retentionDays},
            onSelectionChanged: (v) => _save({'retentionDays': v.first}),
          ),
        ),
        const SizedBox(height: 6),
        const Text('Older days are deleted automatically.', style: TextStyle(color: AppColors.muted, fontSize: 13.5)),
        const SizedBox(height: 20),
        MenuGroup(children: [
          MenuRow(icon: Icons.delete_outline, title: 'Delete all location history', danger: true, onTap: _deleteAll),
        ]),
        const NoticeBox(text: 'Recording pauses by itself when the battery is low. It uses a little more battery while on.'),
      ]),
    );
  }
}

/// What full-day location does, before it is turned on the first time.
class DailyConsentScreen extends StatelessWidget {
  const DailyConsentScreen({super.key});

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: const Text('Before you turn it on')),
        body: ListView(padding: const EdgeInsets.fromLTRB(20, 8, 20, 32), children: [
          const ScreenTitle('Full-day location'),
          const SizedBox(height: 16),
          for (final (icon, text) in const [
            (Icons.location_on_outlined, 'Your phone records where you are every few minutes, also when the app is closed.'),
            (Icons.lock_outline, 'Only you can see your timeline. Admins see only counts, never where you went.'),
            (Icons.people_outline, 'Guardians do not get it. If you start an SOS, they see your live location as before.'),
            (Icons.history, 'It is deleted after 7, 30 or 90 days (you choose). You can delete a day or everything at any time.'),
            (Icons.battery_alert_outlined, 'It uses some battery and pauses when the battery is low.'),
            (Icons.power_settings_new, 'You can pause it or turn it off whenever you want.'),
          ])
            Padding(
              padding: const EdgeInsets.only(bottom: 14),
              child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                IconTile(icon, size: 36),
                const SizedBox(width: 12),
                Expanded(child: Padding(padding: const EdgeInsets.only(top: 6), child: Text(text, style: const TextStyle(fontSize: 15, height: 1.4)))),
              ]),
            ),
          const SizedBox(height: 12),
          FilledButton(key: const Key('daily-agree'), onPressed: () => Navigator.pop(context, true), child: const Text('I agree, turn it on')),
          const SizedBox(height: 8),
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Not now')),
        ]),
      );
}

String distanceText(int m) => m >= 1000 ? '${(m / 1000).toStringAsFixed(1)} km' : '$m m';

String minutesText(int min) => min >= 60 ? '${min ~/ 60} h ${min % 60} min' : '$min min';

/// My timeline (feature 7): stops and routes for one day, a PDF report, delete the day.
class TimelineScreen extends StatefulWidget {
  const TimelineScreen({super.key});

  @override
  State<TimelineScreen> createState() => _TimelineScreenState();
}

class _TimelineScreenState extends State<TimelineScreen> {
  late final AppState _state = AppScope.read(context);
  DateTime _day = DateTime.now();
  Timeline? _t;
  String? _error;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final t = await _state.api.timeline(_day);
      final maps = MapsService();
      for (final s in t.stops.take(30)) {
        s.name = await maps.areaName(s.lat, s.lng).catchError((_) => null);
      }
      if (mounted) setState(() => _t = t);
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } catch (_) {
      if (mounted) setState(() => _error = 'Could not load this day. Pull down to try again.');
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _pickDay() async {
    final now = DateTime.now();
    final d = await showDatePicker(
      context: context,
      initialDate: _day,
      firstDate: now.subtract(Duration(days: _state.daily.retentionDays)),
      lastDate: now,
    );
    if (d == null) return;
    _day = d;
    await _load();
  }

  Future<void> _deleteDay() async {
    if (!await confirm(context, 'Delete this day?', 'Your location history for ${DateFormat('d MMM y').format(_day)} is deleted for good.',
        yes: 'Delete', danger: true)) {
      return;
    }
    try {
      await _state.api.deleteDailyDay(_day);
      await _load();
    } catch (e) {
      if (mounted) showError(context, e);
    }
  }

  /// Daily report as a PDF, saved into Mere Saboot (feature 8).
  Future<void> _report() async {
    final t = _t;
    if (t == null) return;
    final vault = _state.vault;
    try {
      final mode = await vault.state();
      if (mode == 'setup' || mode == 'restore') {
        if (mounted) showInfo(context, 'Set up Mere Saboot first to keep reports.');
        return;
      }
      if (!vault.isOpen && !await vault.unlock()) return;
      final rows = <ReportRow>[
        for (final s in t.stops)
          ReportRow(s.name ?? 'Stop', [
            '${clock(s.arrivedAt)} – ${clock(s.leftAt)} (${minutesText(s.minutes)})',
            'Location: ${s.lat.toStringAsFixed(5)}, ${s.lng.toStringAsFixed(5)}',
          ]),
      ];
      final label = DateFormat('d MMM y').format(_day);
      final path = await buildReportPdf(
        fileName: 'Day ${t.date}.pdf',
        title: 'Daily location report – $label',
        intro: [
          'Distance moved: ${distanceText(t.distanceM)}',
          'Time moving: ${minutesText(t.movingMinutes)}',
          'Stops (5 minutes or more): ${t.stops.length}',
          'Location points recorded: ${t.pointsCount}',
        ],
        rows: rows,
        footer: const ['Made by Sarthi Rakshak from the location points this phone recorded.'],
      );
      await vault.addFile(path: path, kind: 'report', details: ItemDetails(fileName: 'Daily report $label.pdf', mime: 'application/pdf'), deleteSource: true);
      await vault.log('report');
      if (mounted) showInfo(context, 'Report saved to Mere Saboot.');
    } on VaultProblem catch (e) {
      if (mounted) showInfo(context, e.message);
    } catch (e) {
      if (mounted) showError(context, e);
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = _t;
    final today = DateUtils.isSameDay(_day, DateTime.now());
    return Scaffold(
      appBar: AppBar(
        title: const Text('My timeline'),
        actions: [
          if (t != null && t.pointsCount > 0) ...[
            IconButton(tooltip: 'Save report', icon: const Icon(Icons.picture_as_pdf_outlined), onPressed: _report),
            IconButton(tooltip: 'Delete this day', icon: const Icon(Icons.delete_outline), onPressed: _deleteDay),
          ],
        ],
      ),
      body: RefreshIndicator(
        onRefresh: _load,
        child: ListView(padding: const EdgeInsets.fromLTRB(20, 8, 20, 32), children: [
          AppCard(
            onTap: _pickDay,
            padding: const EdgeInsets.fromLTRB(16, 12, 12, 12),
            child: Row(children: [
              const Icon(Icons.calendar_today_outlined, color: AppColors.red, size: 22),
              const SizedBox(width: 12),
              Expanded(
                child: Text(today ? 'Today' : DateFormat('EEEE, d MMM y').format(_day),
                    style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w700)),
              ),
              const Icon(Icons.expand_more, color: AppColors.muted),
            ]),
          ),
          const SizedBox(height: 16),
          if (_loading && t == null) const Padding(padding: EdgeInsets.all(40), child: Center(child: CircularProgressIndicator())),
          if (_error != null) NoticeBox(text: _error!, icon: Icons.error_outline, color: AppColors.red, background: AppColors.redSoft),
          if (t != null && t.pointsCount == 0)
            const AppCard(child: EmptyState(icon: Icons.location_off_outlined, text: 'Nothing recorded on this day.')),
          if (t != null && t.pointsCount > 0) ...[
            Row(children: [
              Expanded(child: _Stat('Distance', distanceText(t.distanceM))),
              const SizedBox(width: 10),
              Expanded(child: _Stat('Moving', minutesText(t.movingMinutes))),
              const SizedBox(width: 10),
              Expanded(child: _Stat('Stops', '${t.stops.length}')),
            ]),
            const SizedBox(height: 16),
            if (AppConfig.mapsApiKey.isNotEmpty) ...[
              ClipRRect(borderRadius: BorderRadius.circular(16), child: SizedBox(height: 240, child: _TimelineMap(t))),
              const SizedBox(height: 16),
            ],
            const SectionLabel('Your day'),
            AppCard(padding: const EdgeInsets.fromLTRB(16, 12, 16, 12), child: _Entries(t)),
          ],
        ]),
      ),
    );
  }
}

class _Stat extends StatelessWidget {
  const _Stat(this.label, this.value);
  final String label;
  final String value;

  @override
  Widget build(BuildContext context) => AppCard(
        padding: const EdgeInsets.symmetric(vertical: 12, horizontal: 8),
        child: Column(children: [
          FittedBox(child: Text(value, style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w800))),
          const SizedBox(height: 2),
          Text(label, maxLines: 1, style: const TextStyle(color: AppColors.muted, fontSize: 13)),
        ]),
      );
}

/// Stops and routes in time order.
class _Entries extends StatelessWidget {
  const _Entries(this.t);
  final Timeline t;

  @override
  Widget build(BuildContext context) {
    final entries = <(DateTime, Widget)>[
      for (final s in t.stops)
        (
          s.arrivedAt,
          _Entry(
            icon: Icons.place,
            color: AppColors.red,
            title: s.name ?? 'Stop',
            subtitle: '${clock(s.arrivedAt)} – ${clock(s.leftAt)} · ${minutesText(s.minutes)}',
          ),
        ),
      for (final r in t.routes)
        (
          r.from,
          _Entry(
            icon: Icons.route,
            color: AppColors.muted,
            title: 'Moved ${distanceText(r.distanceM)}',
            subtitle: '${clock(r.from)} – ${clock(r.to)}',
          ),
        ),
    ]..sort((a, b) => a.$1.compareTo(b.$1));
    return Column(children: [for (final e in entries) e.$2]);
  }
}

class _Entry extends StatelessWidget {
  const _Entry({required this.icon, required this.color, required this.title, required this.subtitle});
  final IconData icon;
  final Color color;
  final String title;
  final String subtitle;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 8),
        child: Row(children: [
          Icon(icon, color: color, size: 22),
          const SizedBox(width: 12),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(title, style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 15)),
              Text(subtitle, style: const TextStyle(color: AppColors.muted, fontSize: 13.5)),
            ]),
          ),
        ]),
      );
}

class _TimelineMap extends StatelessWidget {
  const _TimelineMap(this.t);
  final Timeline t;

  @override
  Widget build(BuildContext context) {
    final all = [for (final r in t.routes) ...r.points, for (final s in t.stops) (s.lat, s.lng)];
    if (all.isEmpty) return const SizedBox.shrink();
    var minLat = all.first.$1, maxLat = all.first.$1, minLng = all.first.$2, maxLng = all.first.$2;
    for (final p in all) {
      if (p.$1 < minLat) minLat = p.$1;
      if (p.$1 > maxLat) maxLat = p.$1;
      if (p.$2 < minLng) minLng = p.$2;
      if (p.$2 > maxLng) maxLng = p.$2;
    }
    final bounds = LatLngBounds(southwest: LatLng(minLat, minLng), northeast: LatLng(maxLat + 0.0001, maxLng + 0.0001));
    return GoogleMap(
      initialCameraPosition: CameraPosition(target: LatLng((minLat + maxLat) / 2, (minLng + maxLng) / 2), zoom: 13),
      zoomControlsEnabled: false,
      myLocationButtonEnabled: false,
      onMapCreated: (c) => Future.delayed(const Duration(milliseconds: 300), () => c.animateCamera(CameraUpdate.newLatLngBounds(bounds, 40))),
      markers: {
        for (final (i, s) in t.stops.indexed)
          Marker(markerId: MarkerId('s$i'), position: LatLng(s.lat, s.lng), infoWindow: InfoWindow(title: s.name ?? 'Stop', snippet: minutesText(s.minutes))),
      },
      polylines: {
        for (final (i, r) in t.routes.indexed)
          Polyline(polylineId: PolylineId('r$i'), points: [for (final p in r.points) LatLng(p.$1, p.$2)], color: AppColors.red, width: 4),
      },
    );
  }
}
