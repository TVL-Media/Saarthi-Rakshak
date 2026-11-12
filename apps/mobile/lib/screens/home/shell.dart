import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../state/app_state.dart';
import '../../theme.dart';
import '../../widgets/common.dart';
import '../community/community_screen.dart';
import '../community/rakshak_screen.dart';
import '../daily/daily_location_screen.dart';
import '../vault/vault_screen.dart';
import '../../widgets/format.dart';
import '../auth/profile_screen.dart';
import '../fakecall/fake_call_screen.dart';
import '../guardians/guardians_screen.dart';
import '../history/history_screen.dart';
import '../settings/settings_screen.dart';
import '../setup/safety_setup_screen.dart';
import '../sos/sos_active_screen.dart';
import '../sos/sos_countdown_screen.dart';
import 'home_screen.dart';

/// Tabs: Home · History · SOS (hold) · Guardians · Settings (design: bottom bar with the red SOS).
class Shell extends StatefulWidget {
  const Shell({super.key});

  @override
  State<Shell> createState() => _ShellState();
}

class _ShellState extends State<Shell> {
  int _tab = 0;

  @override
  Widget build(BuildContext context) {
    final pages = [
      HomeScreen(onOpenTab: (i) => setState(() => _tab = i)),
      const HistoryScreen(),
      const SizedBox.shrink(),
      const GuardiansScreen(),
      const SettingsScreen(),
    ];
    // Back on another tab goes to Home first. On Home, Back must be pressed twice (within 2 s) to
    // leave the app, so a single accidental press never closes it.
    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, _) {
        if (didPop) return;
        if (_tab != 0) {
          setState(() => _tab = 0);
          return;
        }
        final now = DateTime.now();
        if (_backAt != null && now.difference(_backAt!) < const Duration(seconds: 2)) {
          ScaffoldMessenger.of(context).hideCurrentSnackBar();
          SystemNavigator.pop();
          return;
        }
        _backAt = now;
        ScaffoldMessenger.of(context)
          ..hideCurrentSnackBar()
          ..showSnackBar(const SnackBar(content: Text('Press back again to exit'), duration: Duration(seconds: 2)));
      },
      child: _scaffold(pages),
    );
  }

  /// When Back was last pressed on Home.
  DateTime? _backAt;

  Widget _scaffold(List<Widget> pages) {
    return Scaffold(
      drawer: _Menu(onOpenTab: (i) => setState(() => _tab = i)),
      drawerEnableOpenDragGesture: false,
      body: IndexedStack(index: _tab, children: pages),
      // Fixed height: the bar never grows over the page. The red SOS rises above the white bar
      // inside this area, so all of it can be pressed.
      bottomNavigationBar: SafeArea(
        top: false,
        child: SizedBox(
          height: _navHeight,
          child: Stack(
            alignment: Alignment.topCenter,
            children: [
              Positioned(
                left: 12,
                right: 12,
                bottom: 8,
                height: _barHeight,
                child: Container(
                  decoration: BoxDecoration(
                    color: Colors.white,
                    borderRadius: BorderRadius.circular(24),
                    boxShadow: [BoxShadow(color: Colors.black.withValues(alpha: 0.07), blurRadius: 18, offset: const Offset(0, 4))],
                  ),
                  child: Row(
                    children: [
                      _NavItem(icon: Icons.home_outlined, active: Icons.home_rounded, label: 'Home', selected: _tab == 0, onTap: () => setState(() => _tab = 0)),
                      _NavItem(icon: Icons.history, active: Icons.history, label: 'History', selected: _tab == 1, onTap: () => setState(() => _tab = 1)),
                      const Expanded(child: SizedBox()),
                      _NavItem(icon: Icons.group_outlined, active: Icons.group, label: 'Guardians', selected: _tab == 3, onTap: () => setState(() => _tab = 3)),
                      _NavItem(icon: Icons.settings_outlined, active: Icons.settings, label: 'Settings', selected: _tab == 4, onTap: () => setState(() => _tab = 4)),
                    ],
                  ),
                ),
              ),
              const Positioned(top: 0, child: SosHoldButton(size: _sosSize)),
            ],
          ),
        ),
      ),
    );
  }
}

const double _barHeight = 66;
const double _sosSize = 64;
const double _navHeight = 8 + _barHeight + 26; // bottom gap + bar + how far the SOS rises above it

/// Side menu from the Home menu button (design frame 6, Phase 1 items only).
class _Menu extends StatelessWidget {
  const _Menu({required this.onOpenTab});
  final void Function(int tab) onOpenTab;

  @override
  Widget build(BuildContext context) {
    final state = AppScope.of(context);
    final me = state.me;
    void tab(int i) {
      Navigator.pop(context);
      onOpenTab(i);
    }

    void open(Widget w) {
      Navigator.pop(context);
      Navigator.push(context, MaterialPageRoute(builder: (_) => w));
    }

    return Drawer(
      backgroundColor: AppColors.night,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.horizontal(right: Radius.circular(24))),
      child: SafeArea(
        child: ListView(
          padding: const EdgeInsets.fromLTRB(12, 16, 12, 16),
          children: [
            InkWell(
              borderRadius: BorderRadius.circular(16),
              onTap: () => open(const ProfileScreen(fromSettings: true)),
              child: Padding(
                padding: const EdgeInsets.all(8),
                child: Row(children: [
                  ProfileAvatar(name: me?.name ?? '', photoUrl: me?.photoUrl, localPhoto: state.localPhoto, size: 56),
                  const SizedBox(width: 14),
                  Expanded(
                    child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Text(me?.name ?? '', style: const TextStyle(color: Colors.white, fontSize: 18, fontWeight: FontWeight.w700)),
                      if (me != null) Text(prettyPhone(me.phone), style: const TextStyle(color: Color(0xFF9CA3AF))),
                    ]),
                  ),
                  const Icon(Icons.chevron_right, color: Colors.white),
                ]),
              ),
            ),
            const SizedBox(height: 12),
            _MenuItem(Icons.home_rounded, 'Home', () => tab(0), selected: true),
            _MenuItem(Icons.route_outlined, 'My Journeys', () => tab(1)),
            _MenuItem(Icons.group, 'Guardians', () => tab(3)),
            _MenuItem(Icons.phone_in_talk_outlined, 'Fake Call', () => open(const FakeCallScreen())),
            _MenuItem(Icons.place_outlined, 'Saved Places', () => open(const SavedPlacesScreen())),
            if (state.feature('vault')) _MenuItem(Icons.lock_outline, 'Mere Saboot', () => open(const VaultScreen())),
            if (state.feature('daily_location')) _MenuItem(Icons.timeline, 'My Timeline', () => open(const TimelineScreen())),
            if (state.feature('community')) _MenuItem(Icons.groups_outlined, 'Community', () => open(const CommunityScreen())),
            if (state.feature('rakshak')) _MenuItem(Icons.volunteer_activism_outlined, 'Become a Rakshak', () => open(const RakshakScreen())),
            _MenuItem(Icons.health_and_safety_outlined, 'Safety Setup', () => open(const SafetySetupScreen())),
            _MenuItem(Icons.settings, 'Settings', () => tab(4)),
            _MenuItem(Icons.help, 'Help & Support', () => open(const ReportProblemScreen())),
            _MenuItem(Icons.logout, 'Logout', () async {
              if (await confirm(context, 'Log out?', 'Protection stops on this phone until you log in again.', yes: 'Log out')) {
                await state.logout();
              }
            }, danger: true),
          ],
        ),
      ),
    );
  }
}

class _MenuItem extends StatelessWidget {
  const _MenuItem(this.icon, this.label, this.onTap, {this.selected = false, this.danger = false});
  final IconData icon;
  final String label;
  final VoidCallback onTap;
  final bool selected;
  final bool danger;

  @override
  Widget build(BuildContext context) {
    final color = danger ? AppColors.red : Colors.white;
    return Padding(
      padding: const EdgeInsets.only(bottom: 2),
      child: Material(
        color: selected ? const Color(0xFF1F2937) : Colors.transparent,
        borderRadius: BorderRadius.circular(14),
        child: InkWell(
          borderRadius: BorderRadius.circular(14),
          onTap: onTap,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 13),
            child: Row(children: [
              Icon(icon, color: color, size: 22),
              const SizedBox(width: 18),
              Flexible(
                child: Text(label,
                    maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: color, fontSize: 16, fontWeight: FontWeight.w500)),
              ),
            ]),
          ),
        ),
      ),
    );
  }
}

class _NavItem extends StatelessWidget {
  const _NavItem({required this.icon, required this.active, required this.label, required this.selected, required this.onTap});
  final IconData icon;
  final IconData active;
  final String label;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final color = selected ? AppColors.red : const Color(0xFF4B5563);
    return Expanded(
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(14),
        child: Column(mainAxisAlignment: MainAxisAlignment.center, children: [
          Icon(selected ? active : icon, color: color, size: 25),
          const SizedBox(height: 3),
          Text(label, maxLines: 1, style: TextStyle(color: color, fontSize: 11.5, fontWeight: selected ? FontWeight.w700 : FontWeight.w500)),
        ]),
      ),
    );
  }
}

/// The red SOS button: hold for 1 second (avoids accidental presses), then the countdown opens.
class SosHoldButton extends StatefulWidget {
  const SosHoldButton({super.key, this.size = 66, this.journeyId});
  final double size;
  final String? journeyId;

  @override
  State<SosHoldButton> createState() => _SosHoldButtonState();
}

class _SosHoldButtonState extends State<SosHoldButton> with SingleTickerProviderStateMixin {
  late final _hold = AnimationController(vsync: this, duration: const Duration(seconds: 1))
    ..addStatusListener((s) {
      if (s == AnimationStatus.completed) _fire();
    });

  @override
  void dispose() {
    _hold.dispose();
    super.dispose();
  }

  void _fire() {
    HapticFeedback.heavyImpact();
    _hold.reset();
    openSos(context, trigger: 'button', journeyId: widget.journeyId);
  }

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTapDown: (_) => _hold.forward(from: 0),
      onTapUp: (_) {
        if (_hold.value < 1) {
          _hold.reverse();
          ScaffoldMessenger.of(context)
            ..hideCurrentSnackBar()
            ..showSnackBar(const SnackBar(content: Text('Hold the SOS button for 1 second')));
        }
      },
      onTapCancel: () => _hold.reverse(),
      child: Semantics(
        button: true,
        label: 'SOS. Hold for one second.',
        child: AnimatedBuilder(
          animation: _hold,
          builder: (_, _) => Stack(alignment: Alignment.center, children: [
            SizedBox(
              width: widget.size + 8,
              height: widget.size + 8,
              child: CircularProgressIndicator(value: _hold.value, strokeWidth: 4, color: AppColors.redDark, backgroundColor: Colors.transparent),
            ),
            Container(
              width: widget.size,
              height: widget.size,
              decoration: BoxDecoration(
                color: AppColors.red,
                shape: BoxShape.circle,
                boxShadow: [BoxShadow(color: AppColors.red.withValues(alpha: 0.35), blurRadius: 14, offset: const Offset(0, 4))],
              ),
              alignment: Alignment.center,
              child: Text('SOS', style: TextStyle(color: Colors.white, fontWeight: FontWeight.w800, fontSize: widget.size * 0.27)),
            ),
          ]),
        ),
      ),
    );
  }
}

/// Opens the SOS countdown — or the running SOS, if there is one (never a second SOS).
void openSos(BuildContext context,
    {required String trigger, String? journeyId, bool? quiet, int? seconds, String? heightM}) {
  final state = AppScope.read(context);
  final running = state.engineState.sosId;
  unawaited(Navigator.of(context, rootNavigator: true).push(MaterialPageRoute(
    fullscreenDialog: true,
    builder: (_) => running != null
        ? SosActiveScreen(sosId: running)
        : SosCountdownScreen(
            trigger: trigger,
            journeyId: journeyId ?? state.engineState.journeyId,
            quiet: quiet,
            seconds: seconds,
            heightM: heightM,
          ),
  )));
}
