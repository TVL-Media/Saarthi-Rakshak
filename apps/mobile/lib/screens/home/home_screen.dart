import 'package:flutter/material.dart';
import 'package:permission_handler/permission_handler.dart';

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
    await state.refreshMe();
    await state.refreshGuardians(quiet: true);
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
          padding: const EdgeInsets.fromLTRB(20, 16, 20, 24),
          children: [
            Text('${greeting()},', style: const TextStyle(color: AppColors.muted, fontSize: 15)),
            const SizedBox(height: 2),
            Text(me?.name ?? '', style: const TextStyle(fontSize: 30, fontWeight: FontWeight.w500)),
            const SizedBox(height: 16),
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
            const SizedBox(height: 22),
            const SectionLabel('Next journey'),
            AppCard(
              onTap: () => _startJourney(),
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 16),
              child: const Row(children: [
                Icon(Icons.search, color: AppColors.muted),
                SizedBox(width: 10),
                Text('Where are you going?', style: TextStyle(fontSize: 17, color: AppColors.muted)),
              ]),
            ),
            if (_places.isNotEmpty) ...[
              const SizedBox(height: 10),
              Wrap(spacing: 8, runSpacing: 8, children: [
                for (final p in _places)
                  ActionChip(
                    label: Text(p.name),
                    backgroundColor: Colors.white,
                    side: const BorderSide(color: AppColors.line),
                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
                    onPressed: () => _startJourney(p),
                  ),
              ]),
            ],
            const SizedBox(height: 16),
            Material(
              color: AppColors.red,
              borderRadius: BorderRadius.circular(18),
              child: InkWell(
                borderRadius: BorderRadius.circular(18),
                onTap: () => _startJourney(),
                child: Padding(
                  padding: const EdgeInsets.all(18),
                  child: Row(children: [
                    const Expanded(
                      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                        Icon(Icons.near_me_outlined, color: Colors.white),
                        SizedBox(height: 14),
                        Text('Start journey', style: TextStyle(color: Colors.white, fontSize: 21, fontWeight: FontWeight.w700)),
                        SizedBox(height: 2),
                        Text('Your guardians can follow you live', style: TextStyle(color: Colors.white70)),
                      ]),
                    ),
                    const Icon(Icons.chevron_right, color: Colors.white, size: 28),
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
    final dot = protected ? const Color(0xFF34D399) : const Color(0xFFFBBF24);
    return GestureDetector(
      onTap: protected ? null : onFix,
      child: Container(
        padding: const EdgeInsets.fromLTRB(18, 16, 18, 12),
        decoration: BoxDecoration(color: AppColors.night, borderRadius: BorderRadius.circular(20)),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            Container(width: 8, height: 8, decoration: BoxDecoration(color: dot, shape: BoxShape.circle)),
            const SizedBox(width: 6),
            Text(protected ? 'PROTECTED' : 'SETUP NEEDED',
                style: TextStyle(color: dot, fontSize: 12, letterSpacing: 1.2, fontWeight: FontWeight.w700)),
          ]),
          const SizedBox(height: 8),
          Text(protected ? 'You are protected' : 'Finish safety setup',
              style: const TextStyle(color: Colors.white, fontSize: 26, fontWeight: FontWeight.w700)),
          const SizedBox(height: 2),
          Text(protected ? 'SOS works even with the screen off' : 'Tap to see what is missing',
              style: const TextStyle(color: Colors.white60)),
          const SizedBox(height: 14),
          const Divider(color: Colors.white12, height: 1),
          const SizedBox(height: 10),
          Row(children: [
            _Stat(icon: Icons.group_outlined, text: '$guardians Guardian${guardians == 1 ? '' : 's'}', ok: guardians > 0),
            _Stat(icon: Icons.near_me_outlined, text: 'Live location', ok: locationOn),
            _Stat(icon: Icons.battery_charging_full, text: 'Always on', ok: batteryOk),
          ]),
        ]),
      ),
    );
  }
}

class _Stat extends StatelessWidget {
  const _Stat({required this.icon, required this.text, required this.ok});
  final IconData icon;
  final String text;
  final bool ok;

  @override
  Widget build(BuildContext context) => Expanded(
        child: Column(children: [
          Icon(ok ? icon : Icons.error_outline, color: ok ? const Color(0xFF34D399) : const Color(0xFFFBBF24), size: 20),
          const SizedBox(height: 4),
          Text(text, style: const TextStyle(color: Colors.white, fontSize: 12.5)),
        ]),
      );
}
