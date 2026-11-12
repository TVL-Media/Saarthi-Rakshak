import 'package:flutter/material.dart';
import 'package:geolocator/geolocator.dart';
import 'package:permission_handler/permission_handler.dart';

import '../../api/maps_service.dart';
import '../../api/models.dart';
import '../../state/app_state.dart';
import '../../theme.dart';
import '../../widgets/common.dart';
import '../community/community_screen.dart';
import '../daily/daily_location_screen.dart';
import '../vault/vault_screen.dart';
import '../../widgets/format.dart';
import '../fakecall/fake_call_screen.dart';
import '../journey/journey_on_screen.dart';
import '../journey/start_journey_screen.dart';
import '../notifications/notifications_screen.dart';
import '../setup/safety_setup_screen.dart';
import '../sos/sos_active_screen.dart';

/// Home (design frame 5). The design's "Safety score" is left out: Phase 1 has no score.
class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key, required this.onOpenTab});
  final void Function(int tab) onOpenTab;

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  List<SavedPlace> _places = const [];
  bool _locationOn = true;
  bool _batteryOk = true;
  String? _area;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final state = AppScope.read(context);
    try {
      final places = await state.api.places();
      if (mounted) setState(() => _places = places);
    } catch (_) {}
    final location = await Permission.locationAlways.isGranted;
    final battery = await state.engine.batteryOptimisationOff();
    if (mounted) {
      setState(() {
        _locationOn = location;
        _batteryOk = battery;
      });
    }
    _loadArea();
    await state.refreshMe();
    await state.refreshGuardians(quiet: true);
  }

  /// "Sector 62, Noida" under the name, from the last known position (no new GPS fix).
  Future<void> _loadArea() async {
    try {
      if (!await Permission.location.isGranted) return;
      final pos = await Geolocator.getLastKnownPosition();
      if (pos == null) return;
      final area = await MapsService().areaName(pos.latitude, pos.longitude);
      if (mounted && area != null) setState(() => _area = area);
    } catch (_) {
      // The line is simply not shown.
    }
  }

  void _startJourney([SavedPlace? place]) {
    final state = AppScope.read(context);
    if (state.engineState.journeyId != null) {
      Navigator.push(context, MaterialPageRoute(builder: (_) => JourneyOnScreen(journeyId: state.engineState.journeyId!)));
      return;
    }
    Navigator.push(context, MaterialPageRoute(builder: (_) => StartJourneyScreen(preset: place)));
  }

  void _open(Widget w) => Navigator.push(context, MaterialPageRoute(builder: (_) => w));

  @override
  Widget build(BuildContext context) {
    final state = AppScope.of(context);
    final me = state.me;
    final engine = state.engineState;
    final accepted = state.guardians.where((g) => g.status == 'accepted').length;
    final active = state.guardians.where((g) => g.status != 'declined').length;
    final protected = accepted > 0 && _locationOn && _batteryOk;

    return SafeArea(
      child: RefreshIndicator(
        onRefresh: _load,
        child: ListView(
          padding: const EdgeInsets.fromLTRB(20, 12, 20, 24),
          children: [
            Row(children: [
              RoundIconButton(
                icon: Icons.menu,
                tooltip: 'Menu',
                onPressed: () => Scaffold.of(context).openDrawer(),
              ),
              const Spacer(),
              // The bell opens the notifications only (SOS and journeys are in the History tab).
              Stack(clipBehavior: Clip.none, children: [
                RoundIconButton(
                  icon: Icons.notifications_none_rounded,
                  tooltip: 'Notifications',
                  onPressed: () => Navigator.push(context, MaterialPageRoute(builder: (_) => const NotificationsScreen())),
                ),
                if (state.hasUnreadNotices)
                  Positioned(
                    right: 10,
                    top: 9,
                    child: IgnorePointer(
                      child: Container(
                        key: const Key('unread-dot'),
                        width: 10,
                        height: 10,
                        decoration: BoxDecoration(
                          color: AppColors.red,
                          shape: BoxShape.circle,
                          border: Border.all(color: Colors.white, width: 1.5),
                        ),
                      ),
                    ),
                  ),
              ]),
            ]),
            const SizedBox(height: 18),
            Text('${greeting()},', style: const TextStyle(color: AppColors.muted, fontSize: 16)),
            const SizedBox(height: 4),
            Text(
              me?.name ?? '',
              style: const TextStyle(fontSize: 32, fontWeight: FontWeight.w400, height: 1.15, letterSpacing: -0.3),
            ),
            if (_area != null) ...[
              const SizedBox(height: 6),
              Row(children: [
                const Icon(Icons.location_on_outlined, size: 18, color: AppColors.muted),
                const SizedBox(width: 4),
                Flexible(child: Text(_area!, style: const TextStyle(color: AppColors.muted, fontSize: 15))),
              ]),
            ],
            const SizedBox(height: 18),
            if (engine.sosId != null)
              _Banner(
                color: AppColors.red,
                icon: Icons.sos,
                text: 'SOS is active. Tap to open.',
                onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => SosActiveScreen(sosId: engine.sosId!))),
              ),
            if (engine.journeyId != null && engine.sosId == null)
              _Banner(
                color: AppColors.green,
                icon: Icons.navigation,
                text: 'Journey on. Tap to open.',
                onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => JourneyOnScreen(journeyId: engine.journeyId!))),
              ),
            _StatusCard(
              protected: protected,
              guardians: active,
              locationOn: _locationOn,
              batteryOk: _batteryOk,
              onFix: () async {
                await Navigator.push(context, MaterialPageRoute(builder: (_) => const SafetySetupScreen()));
                _load();
              },
            ),
            const SizedBox(height: 26),
            const SectionLabel('Next journey'),
            const SizedBox(height: 4),
            Material(
              color: Colors.white,
              borderRadius: BorderRadius.circular(18),
              shadowColor: Colors.black.withValues(alpha: 0.25),
              elevation: 1,
              child: InkWell(
                borderRadius: BorderRadius.circular(18),
                onTap: () => _startJourney(),
                child: const Padding(
                  padding: EdgeInsets.symmetric(horizontal: 18, vertical: 20),
                  child: Row(children: [
                    Icon(Icons.search, color: AppColors.muted, size: 24),
                    SizedBox(width: 12),
                    Flexible(
                      child: Text('Where are you going?',
                          maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 18, color: AppColors.muted)),
                    ),
                  ]),
                ),
              ),
            ),
            if (_places.isNotEmpty) ...[
              const SizedBox(height: 12),
              Wrap(spacing: 8, runSpacing: 8, children: [
                for (final p in _places)
                  ActionChip(
                    avatar: Icon(
                      switch (p.label) { 'home' => Icons.home_outlined, 'work' => Icons.work_outline, _ => Icons.place_outlined },
                      size: 18,
                      color: AppColors.red,
                    ),
                    label: Text(p.name, style: const TextStyle(fontSize: 15, color: AppColors.ink, fontWeight: FontWeight.w500)),
                    backgroundColor: Colors.white,
                    side: const BorderSide(color: AppColors.line),
                    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 8),
                    shape: const StadiumBorder(),
                    onPressed: () => _startJourney(p),
                  ),
              ]),
            ],
            const SizedBox(height: 18),
            Material(
              color: AppColors.red,
              borderRadius: BorderRadius.circular(22),
              elevation: 3,
              shadowColor: AppColors.red.withValues(alpha: 0.5),
              child: InkWell(
                borderRadius: BorderRadius.circular(22),
                onTap: () => _startJourney(),
                child: const Padding(
                  padding: EdgeInsets.fromLTRB(22, 20, 18, 20),
                  child: Row(crossAxisAlignment: CrossAxisAlignment.end, children: [
                    Expanded(
                      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                        Icon(Icons.near_me_outlined, color: Colors.white, size: 28),
                        SizedBox(height: 30),
                        Text('Start journey', style: TextStyle(color: Colors.white, fontSize: 22, fontWeight: FontWeight.w700)),
                        SizedBox(height: 2),
                        Text('Your guardians can follow you live', style: TextStyle(color: Color(0xE6FFFFFF), fontSize: 15)),
                      ]),
                    ),
                    Padding(
                      padding: EdgeInsets.only(bottom: 10),
                      child: Icon(Icons.chevron_right, color: Colors.white, size: 30),
                    ),
                  ]),
                ),
              ),
            ),
            const SizedBox(height: 12),
            AppCard(
              onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => const FakeCallScreen())),
              padding: const EdgeInsets.fromLTRB(16, 14, 12, 14),
              child: const Row(children: [
                IconTile(Icons.phone_in_talk_outlined, size: 44),
                SizedBox(width: 14),
                Expanded(
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text('Fake call', style: TextStyle(fontWeight: FontWeight.w700, fontSize: 16)),
                    SizedBox(height: 2),
                    Text('Get out of an uncomfortable situation', style: TextStyle(color: AppColors.muted, fontSize: 14)),
                  ]),
                ),
                Icon(Icons.chevron_right, color: Color(0xFF9CA3AF)),
              ]),
            ),
            if (state.feature('vault')) ...[
              const SizedBox(height: 12),
              _FeatureCard(
                key: const Key('home-vault'),
                icon: Icons.lock_outline,
                title: 'Mere Saboot',
                text: 'Your evidence, safe and private',
                onTap: () => _open(const VaultScreen()),
              ),
            ],
            if (state.feature('daily_location') || state.feature('community')) ...[
              const SizedBox(height: 12),
              IntrinsicHeight(
                child: Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                  if (state.feature('daily_location'))
                    Expanded(
                      child: _SmallCard(
                        key: const Key('home-daily'),
                        icon: Icons.timeline,
                        title: 'My day',
                        text: state.daily.enabled ? (state.daily.paused ? 'Paused' : 'Full-day location on') : 'Full-day location off',
                        on: state.daily.enabled && !state.daily.paused,
                        onTap: () => _open(const DailyLocationScreen()),
                      ),
                    ),
                  if (state.feature('daily_location') && state.feature('community')) const SizedBox(width: 12),
                  if (state.feature('community'))
                    Expanded(
                      child: _SmallCard(
                        key: const Key('home-community'),
                        icon: Icons.groups_outlined,
                        title: 'Community',
                        text: 'Safety reports near you',
                        onTap: () => _open(const CommunityScreen()),
                      ),
                    ),
                ]),
              ),
            ],
            if (accepted == 0) ...[
              const SizedBox(height: 12),
              GestureDetector(
                onTap: () => widget.onOpenTab(3),
                child: const NoticeBox(
                  icon: Icons.info_outline,
                  text: 'No guardian has accepted yet. Journeys need at least one. SOS still alerts guardians who haven’t answered.',
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

/// A Home row card like "Fake call" (icon tile, title, one line, chevron).
class _FeatureCard extends StatelessWidget {
  const _FeatureCard({super.key, required this.icon, required this.title, required this.text, required this.onTap});
  final IconData icon;
  final String title;
  final String text;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => AppCard(
        onTap: onTap,
        padding: const EdgeInsets.fromLTRB(16, 14, 12, 14),
        child: Row(children: [
          IconTile(icon, size: 44),
          const SizedBox(width: 14),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(title, style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 16)),
              const SizedBox(height: 2),
              Text(text, style: const TextStyle(color: AppColors.muted, fontSize: 14)),
            ]),
          ),
          const Icon(Icons.chevron_right, color: Color(0xFF9CA3AF)),
        ]),
      );
}

/// Half-width Home card (My day, Community).
class _SmallCard extends StatelessWidget {
  const _SmallCard({super.key, required this.icon, required this.title, required this.text, required this.onTap, this.on = false});
  final IconData icon;
  final String title;
  final String text;
  final VoidCallback onTap;
  final bool on;

  @override
  Widget build(BuildContext context) => AppCard(
        onTap: onTap,
        padding: const EdgeInsets.all(14),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            IconTile(icon, size: 40),
            const Spacer(),
            if (on) Container(width: 9, height: 9, decoration: const BoxDecoration(color: AppColors.green, shape: BoxShape.circle)),
          ]),
          const SizedBox(height: 10),
          Text(title, style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 16)),
          const SizedBox(height: 2),
          Text(text, style: const TextStyle(color: AppColors.muted, fontSize: 13.5, height: 1.3)),
        ]),
      );
}

class _Banner extends StatelessWidget {
  const _Banner({required this.color, required this.icon, required this.text, required this.onTap});
  final Color color;
  final IconData icon;
  final String text;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(bottom: 12),
        child: Material(
          color: color,
          borderRadius: BorderRadius.circular(14),
          child: InkWell(
            onTap: onTap,
            borderRadius: BorderRadius.circular(14),
            child: Padding(
              padding: const EdgeInsets.all(14),
              child: Row(children: [
                Icon(icon, color: Colors.white),
                const SizedBox(width: 10),
                Expanded(child: Text(text, style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w700))),
                const Icon(Icons.chevron_right, color: Colors.white),
              ]),
            ),
          ),
        ),
      );
}

const _okGreen = Color(0xFF22C55E);
const _warnAmber = Color(0xFFFBBF24);

/// The dark "PROTECTED / You are safe" card.
class _StatusCard extends StatelessWidget {
  const _StatusCard({
    required this.protected,
    required this.guardians,
    required this.locationOn,
    required this.batteryOk,
    required this.onFix,
  });
  final bool protected;
  final int guardians;
  final bool locationOn;
  final bool batteryOk;
  final VoidCallback onFix;

  @override
  Widget build(BuildContext context) {
    final dot = protected ? _okGreen : _warnAmber;
    return GestureDetector(
      onTap: protected ? null : onFix,
      child: Container(
        padding: const EdgeInsets.fromLTRB(20, 22, 20, 16),
        decoration: BoxDecoration(color: const Color(0xFF16181C), borderRadius: BorderRadius.circular(26)),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Row(children: [
                  Container(width: 7, height: 7, decoration: BoxDecoration(color: dot, shape: BoxShape.circle)),
                  const SizedBox(width: 8),
                  Text(protected ? 'PROTECTED' : 'SETUP NEEDED',
                      style: TextStyle(color: dot, fontSize: 13, letterSpacing: 1.6, fontWeight: FontWeight.w700)),
                ]),
                const SizedBox(height: 10),
                Text(protected ? 'You are safe' : 'Finish safety setup',
                    style: const TextStyle(color: Colors.white, fontSize: 28, fontWeight: FontWeight.w700, letterSpacing: -0.3)),
                const SizedBox(height: 4),
                Text(protected ? 'All systems active' : 'Tap to see what is missing',
                    style: const TextStyle(color: Color(0xFF9CA3AF), fontSize: 15.5)),
              ]),
            ),
            Icon(protected ? Icons.verified_user_outlined : Icons.gpp_maybe_outlined, color: dot, size: 44),
          ]),
          const SizedBox(height: 18),
          const Divider(color: Color(0x22FFFFFF), height: 1),
          const SizedBox(height: 14),
          LayoutBuilder(builder: (context, box) {
            final labels = ['$guardians Guardian${guardians == 1 ? '' : 's'}', 'Live location', 'Device protected'];
            // Three equal columns, all labels on one line in the same size: if the longest one
            // does not fit (narrow phone, large text), all three get a little smaller together.
            final column = ((box.maxWidth - 2) / 3 - 8) * 0.95; // a little room for rounding
            final scaler = MediaQuery.textScalerOf(context);
            final measureStyle = DefaultTextStyle.of(context).style.merge(_Stat.style);
            double widest = 0;
            for (final l in labels) {
              final p = TextPainter(
                text: TextSpan(text: l, style: measureStyle),
                textDirection: TextDirection.ltr,
                textScaler: scaler,
                maxLines: 1,
              )..layout();
              if (p.width > widest) widest = p.width;
              p.dispose();
            }
            final fontSize = _Stat.style.fontSize! * (widest > column ? column / widest : 1);
            return IntrinsicHeight(
              child: Row(children: [
                _Stat(icon: Icons.people_outline, text: labels[0], ok: guardians > 0, fontSize: fontSize),
                const VerticalDivider(color: Color(0x22FFFFFF), width: 1),
                _Stat(icon: Icons.near_me_outlined, text: labels[1], ok: locationOn, iconColor: _okGreen, fontSize: fontSize),
                const VerticalDivider(color: Color(0x22FFFFFF), width: 1),
                _Stat(icon: Icons.smartphone_outlined, text: labels[2], ok: batteryOk, fontSize: fontSize),
              ]),
            );
          }),
        ]),
      ),
    );
  }
}

class _Stat extends StatelessWidget {
  const _Stat({
    required this.icon,
    required this.text,
    required this.ok,
    required this.fontSize,
    this.iconColor = Colors.white,
  });

  static const style = TextStyle(color: Colors.white, fontSize: 13.5, fontWeight: FontWeight.w500);
  final double fontSize;
  final IconData icon;
  final String text;
  final bool ok;
  final Color iconColor;

  @override
  Widget build(BuildContext context) => Expanded(
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 4),
          child: Column(children: [
            Icon(ok ? icon : Icons.error_outline, color: ok ? iconColor : _warnAmber, size: 22),
            const SizedBox(height: 8),
            Text(text,
                maxLines: 1,
                softWrap: false,
                overflow: TextOverflow.fade,
                textAlign: TextAlign.center,
                style: style.copyWith(fontSize: fontSize)),
          ]),
        ),
      );
}
