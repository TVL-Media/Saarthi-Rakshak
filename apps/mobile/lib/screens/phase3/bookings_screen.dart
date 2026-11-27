import 'dart:async';

import 'package:flutter/material.dart';

import '../../api/phase3_api.dart';
import '../../state/app_state.dart';
import '../../theme.dart';
import '../../widgets/common.dart';
import '../../widgets/format.dart';
import 'book_screen.dart';
import 'phase3_common.dart';

/// My bookings, newest first, and the button to book a Rakshak.
class BookingsScreen extends StatefulWidget {
  const BookingsScreen({super.key});

  @override
  State<BookingsScreen> createState() => _BookingsScreenState();
}

class _BookingsScreenState extends State<BookingsScreen> {
  late final AppState _state = AppScope.read(context);
  late Future<List<Booking>> _future = _state.api.bookings();

  Future<void> _reload() async {
    final f = _state.api.bookings();
    setState(() => _future = f);
    try {
      await f;
    } catch (_) {}
  }

  Future<void> _open(Widget page) async {
    await Navigator.push(context, MaterialPageRoute(builder: (_) => page));
    if (mounted) _reload();
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: const Text('My bookings')),
        body: FutureBuilder<List<Booking>>(
          future: _future,
          builder: (context, snap) {
            if (snap.connectionState != ConnectionState.done) return const Center(child: CircularProgressIndicator());
            if (snap.hasError) {
              return phase3Unavailable(snap.error!) ? NotAvailableYet(onRetry: _reload) : LoadFailed(error: snap.error!, onRetry: _reload);
            }
            final list = snap.data!;
            return RefreshIndicator(
              onRefresh: _reload,
              child: ListView(padding: const EdgeInsets.fromLTRB(20, 4, 20, 32), children: [
                FilledButton.icon(
                  onPressed: () => _open(const BookScreen()),
                  icon: const Icon(Icons.add_task),
                  label: const Text('Book a Rakshak'),
                ),
                const SizedBox(height: 18),
                if (list.isEmpty)
                  const EmptyState(icon: Icons.event_available_outlined, text: 'No bookings yet. Book a Rakshak for a visit, a guard or a check on a loved one.')
                else ...[
                  const SectionLabel('Your bookings'),
                  for (final b in list)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 10),
                      child: AppCard(
                        onTap: () => _open(BookingDetailScreen(booking: b)),
                        child: Row(children: [
                          IconTile(b.finished ? Icons.event_available_outlined : Icons.event_outlined, size: 44),
                          const SizedBox(width: 12),
                          Expanded(
                            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                              Text(b.serviceName, style: const TextStyle(fontSize: 16.5, fontWeight: FontWeight.w700)),
                              const SizedBox(height: 2),
                              Text(windowText(b.windowStart, b.windowEnd), style: const TextStyle(color: AppColors.muted, fontSize: 14)),
                            ]),
                          ),
                          const SizedBox(width: 8),
                          StatusPill(statusLabel(b.status), color: statusColor(b.status)),
                        ]),
                      ),
                    ),
                ],
              ]),
            );
          },
        ),
      );
}

/// One booking: where it stands, the quote to accept, the Rakshak, and the history.
/// Refreshes by itself while open (push messages also tell you when something changes).
class BookingDetailScreen extends StatefulWidget {
  const BookingDetailScreen({super.key, required this.booking});
  final Booking booking;

  @override
  State<BookingDetailScreen> createState() => _BookingDetailScreenState();
}

class _BookingDetailScreenState extends State<BookingDetailScreen> with WidgetsBindingObserver {
  late final AppState _state = AppScope.read(context);
  late Booking _b = widget.booking;
  Timer? _timer;
  bool _refreshing = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _schedule();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _timer?.cancel();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState s) {
    if (s == AppLifecycleState.resumed) {
      _refresh();
    } else {
      _timer?.cancel();
    }
  }

  void _schedule() {
    _timer?.cancel();
    if (_b.finished) return;
    _timer = Timer(const Duration(seconds: 15), _refresh);
  }

  Future<void> _refresh() async {
    if (_refreshing || !mounted) return;
    _refreshing = true;
    try {
      final b = await _state.api.booking(_b.id);
      if (mounted) setState(() => _b = b);
    } catch (_) {
      // Keep what is on screen; try again at the next tick.
    } finally {
      _refreshing = false;
      if (mounted) _schedule();
    }
  }

  Future<void> _act(Future<Booking> Function() call) async {
    try {
      final b = await call();
      if (!mounted) return;
      setState(() => _b = b);
      _schedule();
    } catch (e) {
      if (mounted) showError(context, e);
    }
  }

  Future<void> _cancel() async {
    final extra = _b.cancelMessage;
    final ok = await confirm(
      context,
      'Cancel this booking?',
      extra == null || extra.isEmpty ? 'The Rakshak will be told.' : extra,
      yes: 'Cancel booking',
      danger: true,
    );
    if (ok) await _act(() => _state.api.cancelBooking(_b.id));
  }

  @override
  Widget build(BuildContext context) {
    final b = _b;
    final matching = b.matching;
    final searching = !b.finished && b.rakshak == null && matching != null && matching.state != 'no_match' && (b.status == 'requested' || b.status == 'confirmed');
    return Scaffold(
      appBar: AppBar(title: Text(b.serviceName)),
      body: RefreshIndicator(
        onRefresh: _refresh,
        child: ListView(padding: const EdgeInsets.fromLTRB(20, 4, 20, 32), physics: const AlwaysScrollableScrollPhysics(), children: [
          AppCard(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Row(children: [
                Expanded(child: Text(statusLabel(b.status), style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w800))),
                StatusPill(statusLabel(b.status), color: statusColor(b.status)),
              ]),
              const SizedBox(height: 12),
              _line(Icons.schedule, windowText(b.windowStart, b.windowEnd)),
              if (b.placeLabel.isNotEmpty) _line(Icons.place_outlined, b.placeLabel),
              if (b.notes != null && b.notes!.isNotEmpty) _line(Icons.notes, b.notes!),
            ]),
          ),
          // The request is sent; a Rakshak is found and a quote sent by our team (no Rakshak app yet),
          // which can take a while. A clear "sent" message, not a spinner that never stops.
          if (searching) ...[
            const SizedBox(height: 14),
            AppCard(
              key: const Key('booking-sent'),
              child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                const Icon(Icons.check_circle, color: AppColors.green, size: 26),
                const SizedBox(width: 14),
                const Expanded(
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text('Request sent', style: TextStyle(fontSize: 16, fontWeight: FontWeight.w700)),
                    SizedBox(height: 4),
                    Text(
                      'We are finding a Rakshak for this time and will send you a quote to accept. '
                      'You will get a notification, so you can close this screen. Pull down to check for updates.',
                      style: TextStyle(color: AppColors.muted, height: 1.4),
                    ),
                  ]),
                ),
              ]),
            ),
          ],
          if (!b.finished && matching?.state == 'no_match') ...[
            const SizedBox(height: 14),
            NoticeBox(text: matching?.message ?? 'No Rakshak is free for this time yet. We will keep trying and tell you.'),
          ],
          if (b.rakshak != null) ...[
            const SizedBox(height: 14),
            AppCard(
              child: Row(children: [
                Initials(b.rakshak!.firstName, size: 48),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text(b.rakshak!.firstName, style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w700)),
                    const Text('Your verified Rakshak', style: TextStyle(color: AppColors.muted)),
                  ]),
                ),
                if (b.rakshak!.etaMinutes != null && !b.finished) StatusPill('~${b.rakshak!.etaMinutes} min', color: AppColors.green),
              ]),
            ),
          ],
          if (b.status == 'quoted' && b.quote != null) ...[
            const SizedBox(height: 14),
            AppCard(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                const SectionLabel('Quote'),
                Text(money(b.quote!.amountPaise), style: const TextStyle(fontSize: 28, fontWeight: FontWeight.w800)),
                if (b.quote!.note != null && b.quote!.note!.isNotEmpty)
                  Padding(padding: const EdgeInsets.only(top: 6), child: Text(b.quote!.note!, style: const TextStyle(height: 1.4))),
                if (b.quote!.expiresAt != null)
                  Padding(
                    padding: const EdgeInsets.only(top: 6),
                    child: Text('Valid until ${dateTime(b.quote!.expiresAt!)}', style: const TextStyle(color: AppColors.muted, fontSize: 13.5)),
                  ),
                const SizedBox(height: 14),
                BusyButton(label: 'Accept quote', onPressed: () => _act(() => _state.api.acceptQuote(b.id))),
                const SizedBox(height: 8),
                OutlinedButton(
                  onPressed: () => _act(() => _state.api.declineQuote(b.id)),
                  child: const Text('Decline'),
                ),
              ]),
            ),
          ],
          if (b.history.isNotEmpty) ...[
            const SizedBox(height: 18),
            const SectionLabel('History'),
            AppCard(
              child: Column(children: [
                for (var i = 0; i < b.history.length; i++)
                  Padding(
                    padding: EdgeInsets.only(bottom: i == b.history.length - 1 ? 0 : 12),
                    child: Row(children: [
                      Icon(Icons.circle, size: 10, color: statusColor(b.history[i].status)),
                      const SizedBox(width: 12),
                      Expanded(child: Text(statusLabel(b.history[i].status), style: const TextStyle(fontWeight: FontWeight.w600))),
                      Text(dateTime(b.history[i].at), style: const TextStyle(color: AppColors.muted, fontSize: 13)),
                    ]),
                  ),
              ]),
            ),
          ],
          if (!b.finished && b.canCancel) ...[
            const SizedBox(height: 20),
            OutlinedButton(
              onPressed: _cancel,
              style: OutlinedButton.styleFrom(foregroundColor: AppColors.redDark),
              child: const Text('Cancel booking'),
            ),
          ],
        ]),
      ),
    );
  }

  Widget _line(IconData icon, String text) => Padding(
        padding: const EdgeInsets.only(bottom: 8),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Icon(icon, size: 19, color: AppColors.muted),
          const SizedBox(width: 10),
          Expanded(child: Text(text, style: const TextStyle(fontSize: 15.5, height: 1.35))),
        ]),
      );
}
