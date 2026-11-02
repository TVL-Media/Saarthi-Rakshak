import 'package:flutter/material.dart';

import '../api/api_client.dart';
import '../theme.dart';

/// A white rounded card as in the design.
class AppCard extends StatelessWidget {
  const AppCard({super.key, required this.child, this.padding = const EdgeInsets.all(16), this.color, this.onTap});
  final Widget child;
  final EdgeInsetsGeometry padding;
  final Color? color;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final card = Container(
      padding: padding,
      decoration: BoxDecoration(
        color: color ?? AppColors.card,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: AppColors.line.withValues(alpha: 0.6)),
      ),
      child: child,
    );
    if (onTap == null) return card;
    return Material(
      color: Colors.transparent,
      child: InkWell(borderRadius: BorderRadius.circular(16), onTap: onTap, child: card),
    );
  }
}

/// Small grey caps label ("NEXT JOURNEY").
class SectionLabel extends StatelessWidget {
  const SectionLabel(this.text, {super.key});
  final String text;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(bottom: 8, top: 4),
        child: Text(
          text.toUpperCase(),
          style: const TextStyle(fontSize: 12, letterSpacing: 1.1, color: AppColors.muted, fontWeight: FontWeight.w600),
        ),
      );
}

/// A big title + grey subtitle at the top of a screen.
class ScreenTitle extends StatelessWidget {
  const ScreenTitle(this.title, {super.key, this.subtitle});
  final String title;
  final String? subtitle;

  @override
  Widget build(BuildContext context) => Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(title, style: const TextStyle(fontSize: 28, fontWeight: FontWeight.w800, height: 1.15)),
          if (subtitle != null) ...[
            const SizedBox(height: 6),
            Text(subtitle!, style: const TextStyle(fontSize: 16, color: AppColors.muted, height: 1.35)),
          ],
        ],
      );
}

/// A filled button that shows a spinner while [onPressed] runs.
class BusyButton extends StatefulWidget {
  const BusyButton({super.key, required this.label, required this.onPressed, this.color, this.icon});
  final String label;
  final Future<void> Function()? onPressed;
  final Color? color;
  final IconData? icon;

  @override
  State<BusyButton> createState() => _BusyButtonState();
}

class _BusyButtonState extends State<BusyButton> {
  bool _busy = false;

  @override
  Widget build(BuildContext context) {
    final style = widget.color == null ? null : FilledButton.styleFrom(backgroundColor: widget.color);
    final child = _busy
        ? const SizedBox(width: 22, height: 22, child: CircularProgressIndicator(strokeWidth: 2.5, color: Colors.white))
        : Row(mainAxisSize: MainAxisSize.min, children: [
            Text(widget.label),
            if (widget.icon != null) ...[const SizedBox(width: 8), Icon(widget.icon, size: 20)],
          ]);
    return FilledButton(
      style: style,
      onPressed: widget.onPressed == null || _busy
          ? null
          : () async {
              setState(() => _busy = true);
              try {
                await widget.onPressed!();
              } finally {
                if (mounted) setState(() => _busy = false);
              }
            },
      child: child,
    );
  }
}

/// Shows an error from the server (or any exception) at the bottom.
void showError(BuildContext context, Object error) {
  final text = error is ApiException ? error.message : 'Something went wrong. Please try again.';
  ScaffoldMessenger.of(context)
    ..hideCurrentSnackBar()
    ..showSnackBar(SnackBar(content: Text(text)));
}

void showInfo(BuildContext context, String text) {
  ScaffoldMessenger.of(context)
    ..hideCurrentSnackBar()
    ..showSnackBar(SnackBar(content: Text(text)));
}

/// Yes / no question; returns true for yes.
Future<bool> confirm(BuildContext context, String title, String message, {String yes = 'Yes', bool danger = false}) async {
  final ok = await showDialog<bool>(
    context: context,
    builder: (c) => AlertDialog(
      title: Text(title),
      content: Text(message),
      actions: [
        TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('Cancel')),
        FilledButton(
          style: danger ? FilledButton.styleFrom(backgroundColor: AppColors.red, minimumSize: const Size(0, 44)) : FilledButton.styleFrom(minimumSize: const Size(0, 44)),
          onPressed: () => Navigator.pop(c, true),
          child: Text(yes),
        ),
      ],
    ),
  );
  return ok ?? false;
}

/// Empty state with an icon.
class EmptyState extends StatelessWidget {
  const EmptyState({super.key, required this.icon, required this.text});
  final IconData icon;
  final String text;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 48, horizontal: 24),
        child: Column(children: [
          Icon(icon, size: 48, color: AppColors.muted),
          const SizedBox(height: 12),
          Text(text, textAlign: TextAlign.center, style: const TextStyle(color: AppColors.muted, fontSize: 16)),
        ]),
      );
}

/// Round avatar with initials.
class Initials extends StatelessWidget {
  const Initials(this.name, {super.key, this.size = 48});
  final String name;
  final double size;

  @override
  Widget build(BuildContext context) {
    final parts = name.trim().split(RegExp(r'\s+')).where((p) => p.isNotEmpty).toList();
    final text = parts.isEmpty ? '?' : parts.take(2).map((p) => p.characters.first.toUpperCase()).join();
    return CircleAvatar(
      radius: size / 2,
      backgroundColor: AppColors.redSoft,
      child: Text(text, style: TextStyle(color: AppColors.redDark, fontWeight: FontWeight.w700, fontSize: size * 0.36)),
    );
  }
}

/// White round icon button (design: menu, bell and back buttons at the top of a screen).
class RoundIconButton extends StatelessWidget {
  const RoundIconButton({super.key, required this.icon, required this.onPressed, this.tooltip});
  final IconData icon;
  final VoidCallback onPressed;
  final String? tooltip;

  @override
  Widget build(BuildContext context) => Material(
        color: Colors.white,
        shape: const CircleBorder(),
        elevation: 0.5,
        shadowColor: Colors.black26,
        child: IconButton(
          tooltip: tooltip,
          icon: Icon(icon, color: AppColors.ink, size: 24),
          onPressed: onPressed,
        ),
      );
}
