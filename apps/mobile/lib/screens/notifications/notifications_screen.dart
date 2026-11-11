import 'package:flutter/material.dart';

import '../../state/app_state.dart';
import '../../theme.dart';
import '../../widgets/common.dart';
import '../../widgets/format.dart';
import '../community/community_screen.dart';
import '../community/rakshak_screen.dart';
import '../settings/plans_screen.dart';

/// The page a Phase 2 notification belongs to (null: nothing to open).
Widget? noticePage(String? type) => switch (type) {
      'community_status' => const MyReportsScreen(),
      'rakshak_status' => const RakshakScreen(),
      'plan_status' => const PlansScreen(),
      _ => null,
    };

/// The bell on Home: notifications this phone received, and where each guardian invite stands.
/// (SOS and journeys are in the History tab, not here.)
class NotificationsScreen extends StatefulWidget {
  const NotificationsScreen({super.key});

  @override
  State<NotificationsScreen> createState() => _NotificationsScreenState();
}

class _NotificationsScreenState extends State<NotificationsScreen> {
  late final AppState _state = AppScope.read(context);

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _state.markNoticesSeen());
    _state.refreshGuardians(quiet: true).catchError((_) {});
  }

  @override
  Widget build(BuildContext context) {
    final state = AppScope.of(context);
    final notices = state.notices;
    final guardians = state.guardians;
    return Scaffold(
      appBar: AppBar(title: const Text('Notifications')),
      body: notices.isEmpty && guardians.isEmpty
          ? const Center(
              child: EmptyState(
                icon: Icons.notifications_none_rounded,
                text: 'No notifications yet.\nGuardian replies and check-in alerts will appear here.',
              ),
            )
          : ListView(
              padding: const EdgeInsets.fromLTRB(20, 8, 20, 24),
              children: [
                if (notices.isNotEmpty) ...[
                  const SectionLabel('Recent'),
                  AppCard(
                    padding: EdgeInsets.zero,
                    child: Column(children: [
                      for (final (i, n) in notices.indexed) ...[
                        if (i > 0) const Divider(height: 1, thickness: 1, indent: 68, color: Color(0xFFF0ECE7)),
                        _NoticeRow(n),
                      ],
                    ]),
                  ),
                  const SizedBox(height: 20),
                ],
                if (guardians.isNotEmpty) ...[
                  const SectionLabel('Guardian invites'),
                  AppCard(
                    padding: EdgeInsets.zero,
                    child: Column(children: [
                      for (final (i, g) in guardians.indexed) ...[
                        if (i > 0) const Divider(height: 1, thickness: 1, indent: 68, color: Color(0xFFF0ECE7)),
                        _Row(
                          icon: switch (g.status) {
                            'accepted' => Icons.how_to_reg_outlined,
                            'declined' => Icons.person_off_outlined,
                            _ => Icons.schedule,
                          },
                          color: switch (g.status) {
                            'accepted' => AppColors.green,
                            'declined' => AppColors.muted,
                            _ => AppColors.amber,
                          },
                          title: switch (g.status) {
                            'accepted' => '${g.name} accepted your invite',
                            'declined' => '${g.name} declined your invite',
                            _ => '${g.name} has not answered your invite yet',
                          },
                          body: switch (g.status) {
                            'accepted' => 'They will get your SOS alerts and can follow your journeys.',
                            'declined' => 'They will not get your alerts.',
                            _ => 'SOS alerts still reach them. You can send the invite again from Guardians.',
                          },
                        ),
                      ],
                    ]),
                  ),
                ],
              ],
            ),
    );
  }
}

class _NoticeRow extends StatelessWidget {
  const _NoticeRow(this.n);
  final AppNotice n;

  @override
  Widget build(BuildContext context) {
    final (icon, color) = switch (n.type) {
      'guardian_status' => (Icons.people_outline, AppColors.green),
      'show_call_112' => (Icons.call_outlined, AppColors.red),
      'checkin_no_reply' => (Icons.warning_amber_rounded, AppColors.amber),
      'community_status' => (Icons.groups_outlined, AppColors.red),
      'rakshak_status' => (Icons.volunteer_activism_outlined, AppColors.red),
      'plan_status' => (Icons.workspace_premium_outlined, AppColors.red),
      _ => (Icons.notifications_none_rounded, AppColors.red),
    };
    final page = noticePage(n.type);
    final row = _Row(icon: icon, color: color, title: n.title, body: n.body, time: ago(n.at));
    if (page == null) return row;
    return InkWell(onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => page)), child: row);
  }
}

class _Row extends StatelessWidget {
  const _Row({required this.icon, required this.color, required this.title, this.body, this.time});
  final IconData icon;
  final Color color;
  final String title;
  final String? body;
  final String? time;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.fromLTRB(14, 14, 16, 14),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          IconTile(icon, color: color),
          const SizedBox(width: 14),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Expanded(
                  child: Text(title, style: const TextStyle(fontSize: 15.5, fontWeight: FontWeight.w700, height: 1.3)),
                ),
                if (time != null) ...[
                  const SizedBox(width: 8),
                  Text(time!, style: const TextStyle(fontSize: 12.5, color: AppColors.muted, height: 1.6)),
                ],
              ]),
              if (body != null && body!.isNotEmpty) ...[
                const SizedBox(height: 3),
                Text(body!, style: const TextStyle(color: AppColors.muted, fontSize: 14, height: 1.35)),
              ],
            ]),
          ),
        ]),
      );
}
