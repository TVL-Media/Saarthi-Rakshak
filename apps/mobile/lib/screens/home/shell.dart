import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../state/app_state.dart';
import '../../theme.dart';
import '../guardians/guardians_screen.dart';
import '../history/history_screen.dart';
import '../settings/settings_screen.dart';
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
    return Scaffold(
      body: IndexedStack(index: _tab, children: pages),
      bottomNavigationBar: SafeArea(
        child: Container(
          margin: const EdgeInsets.fromLTRB(12, 0, 12, 8),
          padding: const EdgeInsets.symmetric(vertical: 6),
          decoration: BoxDecoration(
            color: Colors.white,
            borderRadius: BorderRadius.circular(22),
            boxShadow: [BoxShadow(color: Colors.black.withValues(alpha: 0.06), blurRadius: 16, offset: const Offset(0, 4))],
          ),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              _NavItem(icon: Icons.home_outlined, active: Icons.home, label: 'Home', selected: _tab == 0, onTap: () => setState(() => _tab = 0)),
              _NavItem(icon: Icons.history, active: Icons.history, label: 'History', selected: _tab == 1, onTap: () => setState(() => _tab = 1)),
              const Expanded(child: Center(child: SosHoldButton(size: 66))),
              _NavItem(icon: Icons.group_outlined, active: Icons.group, label: 'Guardians', selected: _tab == 3, onTap: () => setState(() => _tab = 3)),
              _NavItem(icon: Icons.settings_outlined, active: Icons.settings, label: 'Settings', selected: _tab == 4, onTap: () => setState(() => _tab = 4)),
            ],
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
    final color = selected ? AppColors.red : AppColors.muted;
    return Expanded(
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(14),
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 6),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            Icon(selected ? active : icon, color: color),
            const SizedBox(height: 2),
            Text(label, style: TextStyle(color: color, fontSize: 11.5, fontWeight: selected ? FontWeight.w700 : FontWeight.w500)),
          ]),
        ),
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
void openSos(BuildContext context, {required String trigger, String? journeyId}) {
  final state = AppScope.read(context);
  final running = state.engineState.sosId;
  unawaited(Navigator.of(context, rootNavigator: true).push(MaterialPageRoute(
    fullscreenDialog: true,
    builder: (_) => running != null
        ? SosActiveScreen(sosId: running)
        : SosCountdownScreen(trigger: trigger, journeyId: journeyId ?? state.engineState.journeyId),
  )));
}
