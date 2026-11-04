import 'dart:typed_data';

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
    final shape = RoundedRectangleBorder(
      borderRadius: BorderRadius.circular(16),
      side: BorderSide(color: AppColors.line.withValues(alpha: 0.55)),
    );
    // The card colour is the Material itself, so the tap ripple shows on top of it (a tap that
    // shows nothing makes people tap again). A very soft shadow lifts it off the cream page.
    return Material(
      color: color ?? AppColors.card,
      shape: shape,
      elevation: 0.6,
      shadowColor: Colors.black.withValues(alpha: 0.18),
      clipBehavior: Clip.antiAlias,
      child: onTap == null
          ? Padding(padding: padding, child: child)
          : InkWell(onTap: onTap, child: Padding(padding: padding, child: child)),
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
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: const TextStyle(fontSize: 12, letterSpacing: 1.1, color: AppColors.muted, fontWeight: FontWeight.w600),
        ),
      );
}

/// Title row of a bottom-bar tab (History, Guardians, Settings): the same height and left edge
/// on every tab, with an optional button on the right.
class TabHeader extends StatelessWidget {
  const TabHeader(this.title, {super.key, this.subtitle, this.trailing});
  final String title;
  final String? subtitle;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(bottom: 18),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          SizedBox(
            height: 48,
            child: Row(children: [
              Expanded(
                child: Text(title,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(fontSize: 28, fontWeight: FontWeight.w800, height: 1.1)),
              ),
              ?trailing,
            ]),
          ),
          if (subtitle != null) ...[
            const SizedBox(height: 2),
            Text(subtitle!, style: const TextStyle(fontSize: 15, color: AppColors.muted, height: 1.4)),
          ],
        ]),
      );
}

/// A rounded square with a tinted background and an icon (list rows, notices).
class IconTile extends StatelessWidget {
  const IconTile(this.icon, {super.key, this.color = AppColors.red, this.background, this.size = 40});
  final IconData icon;
  final Color color;
  final Color? background;
  final double size;

  @override
  Widget build(BuildContext context) => Container(
        width: size,
        height: size,
        decoration: BoxDecoration(
          color: background ?? color.withValues(alpha: 0.1),
          borderRadius: BorderRadius.circular(size * 0.3),
        ),
        child: Icon(icon, color: color, size: size * 0.52),
      );
}

/// A white card holding rows separated by thin lines (Settings, details).
class MenuGroup extends StatelessWidget {
  const MenuGroup({super.key, required this.children, this.label});
  final List<Widget> children;
  final String? label;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(bottom: 16),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          if (label != null) Padding(padding: const EdgeInsets.only(left: 4), child: SectionLabel(label!)),
          AppCard(
            padding: EdgeInsets.zero,
            child: Column(children: [
              for (var i = 0; i < children.length; i++) ...[
                if (i > 0) const Divider(height: 1, thickness: 1, indent: 68, color: Color(0xFFF0ECE7)),
                children[i],
              ],
            ]),
          ),
        ]),
      );
}

/// One tappable row of a [MenuGroup]: icon tile, title (and subtitle), chevron.
class MenuRow extends StatelessWidget {
  const MenuRow({
    super.key,
    required this.icon,
    required this.title,
    this.subtitle,
    this.onTap,
    this.danger = false,
    this.accent = false,
    this.trailing,
  });

  /// Red icon on a light red tile (places, features) instead of the neutral grey one.
  final bool accent;
  final IconData icon;
  final String title;
  final String? subtitle;
  final VoidCallback? onTap;
  final bool danger;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) => InkWell(
        onTap: onTap,
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: 60),
          child: Padding(
            padding: const EdgeInsets.fromLTRB(14, 10, 12, 10),
            child: Row(children: [
              IconTile(icon,
                  color: danger || accent ? AppColors.red : AppColors.ink,
                  size: 40,
                  background: danger || accent ? AppColors.redSoft : const Color(0xFFF3F0EC)),
              const SizedBox(width: 14),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
                  Text(title,
                      style: TextStyle(
                          fontSize: 16, fontWeight: FontWeight.w600, color: danger ? AppColors.red : AppColors.ink)),
                  if (subtitle != null) ...[
                    const SizedBox(height: 2),
                    Text(subtitle!,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(fontSize: 13.5, color: AppColors.muted, height: 1.3)),
                  ],
                ]),
              ),
              const SizedBox(width: 8),
              trailing ?? const Icon(Icons.chevron_right, color: Color(0xFF9CA3AF)),
            ]),
          ),
        ),
      );
}

/// A small rounded status label ("Arrived safely", "Accepted").
class StatusPill extends StatelessWidget {
  const StatusPill(this.text, {super.key, this.color = AppColors.muted});
  final String text;
  final Color color;

  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
        decoration: BoxDecoration(color: color.withValues(alpha: 0.1), borderRadius: BorderRadius.circular(20)),
        child: Text(text, style: TextStyle(color: color, fontSize: 12.5, fontWeight: FontWeight.w700)),
      );
}

/// A coloured notice box with an icon (warnings, the "not 24/7" line, tips).
class NoticeBox extends StatelessWidget {
  const NoticeBox({super.key, required this.text, this.icon = Icons.info_outline, this.color = AppColors.amber, this.background = AppColors.amberSoft});
  final String text;
  final IconData icon;
  final Color color;
  final Color background;

  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
        decoration: BoxDecoration(color: background, borderRadius: BorderRadius.circular(14)),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Icon(icon, color: color, size: 20),
          const SizedBox(width: 10),
          Expanded(child: Text(text, style: TextStyle(color: color, fontWeight: FontWeight.w600, height: 1.4))),
        ]),
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
  // Not from the server: say what failed in the app, so it can be reported and fixed.
  if (error is! ApiException) debugPrint('App error: $error');
  final text = error is ApiException
      ? error.message
      : 'Something went wrong in the app (${error.runtimeType}). Please try again.';
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

/// The user's photo: the copy on this phone first, then the one on the server, else initials.
class ProfileAvatar extends StatelessWidget {
  const ProfileAvatar({super.key, required this.name, this.photoUrl, this.localPhoto, this.size = 56});
  final String name;
  final String? photoUrl;
  final Uint8List? localPhoto;
  final double size;

  @override
  Widget build(BuildContext context) {
    if (localPhoto != null) return CircleAvatar(radius: size / 2, backgroundImage: MemoryImage(localPhoto!));
    if (photoUrl != null) {
      return CircleAvatar(
        radius: size / 2,
        backgroundColor: AppColors.redSoft,
        backgroundImage: NetworkImage(photoUrl!),
        onBackgroundImageError: (_, _) {},
      );
    }
    return Initials(name, size: size);
  }
}
