import 'package:flutter/material.dart';
import 'package:geolocator/geolocator.dart';
import 'package:permission_handler/permission_handler.dart';

import '../../api/maps_service.dart';
import '../../api/models.dart';
import '../../state/app_state.dart';
import '../../theme.dart';
import '../../widgets/common.dart';
import '../../widgets/format.dart';
import '../fakecall/fake_call_screen.dart';
import '../journey/journey_on_screen.dart';
import '../journey/start_journey_screen.dart';
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
              RoundIconButton(
                icon: Icons.notifications_none_rounded,
                tooltip: 'Alerts and journeys',
                onPressed: () => widget.onOpenTab(1),
              ),
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
                    label: Text(p.name, style: const TextStyle(fontSize: 15.5, color: AppColors.ink)),
                    backgroundColor: AppColors.cream,
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
              child: const Row(children: [
                CircleAvatar(backgroundColor: AppColors.redSoft, child: Icon(Icons.phone_in_talk_outlined, color: AppColors.red)),
                SizedBox(width: 12),
                Expanded(
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text('Fake call', style: TextStyle(fontWeight: FontWeight.w700, fontSize: 16)),
                    Text('Get out of an uncomfortable situation', style: TextStyle(color: AppColors.muted)),
                  ]),
                ),
                Icon(Icons.chevron_right, color: AppColors.muted),
              ]),
            ),
            if (accepted == 0) ...[
              const SizedBox(height: 12),
              AppCard(
                color: AppColors.amberSoft,
                onTap: () => widget.onOpenTab(3),
                child: const Text('No guardian has accepted yet. Journeys need at least one. SOS still alerts guardians who haven’t answered.',
                    style: TextStyle(color: AppColors.amber, fontWeight: FontWeight.w600)),
              ),
            ],
          ],
        ),
      ),
    );
  }
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
        padding: const EdgeInsets.fromLTRB(22, 22, 22, 16),
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
          IntrinsicHeight(
            child: Row(children: [
              _Stat(icon: Icons.people_outline, text: '$guardians Guardian${guardians == 1 ? '' : 's'}', ok: guardians > 0),
              const VerticalDivider(color: Color(0x22FFFFFF), width: 1),
              _Stat(icon: Icons.near_me_outlined, text: 'Live location', ok: locationOn, iconColor: _okGreen),
              const VerticalDivider(color: Color(0x22FFFFFF), width: 1),
              _Stat(icon: Icons.smartphone_outlined, text: 'Device protected', ok: batteryOk),
            ]),
          ),
        ]),
      ),
    );
  }
}

class _Stat extends StatelessWidget {
  const _Stat({required this.icon, required this.text, required this.ok, this.iconColor = Colors.white});
  final IconData icon;
  final String text;
  final bool ok;
  final Color iconColor;

  @override
  Widget build(BuildContext context) => Expanded(
        child: Column(children: [
          Icon(ok ? icon : Icons.error_outline, color: ok ? iconColor : _warnAmber, size: 22),
          const SizedBox(height: 6),
          Text(text,
              textAlign: TextAlign.center,
              style: const TextStyle(color: Colors.white, fontSize: 13.5, fontWeight: FontWeight.w500)),
        ]),
      );
}
