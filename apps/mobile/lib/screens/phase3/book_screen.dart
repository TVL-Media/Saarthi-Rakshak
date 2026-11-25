import 'package:flutter/material.dart';
import 'package:geolocator/geolocator.dart';

import '../../api/models.dart';
import '../../api/phase3_api.dart';
import '../../state/app_state.dart';
import '../../theme.dart';
import '../../widgets/common.dart';
import 'bookings_screen.dart';
import 'phase3_common.dart';

/// Book a Rakshak: pick the service, the time and the place, then send the request.
/// The server then finds a Rakshak and replies with a quote.
class BookScreen extends StatefulWidget {
  const BookScreen({super.key});

  @override
  State<BookScreen> createState() => _BookScreenState();
}

class _BookScreenState extends State<BookScreen> {
  late final AppState _state = AppScope.read(context);
  late Future<(List<ServiceType>, List<SavedPlace>)> _future = _load();

  ServiceType? _service;
  late DateTime _date = DateTime.now();
  TimeOfDay _start = TimeOfDay.fromDateTime(DateTime.now().add(const Duration(hours: 1)));
  int _hours = 2;
  SavedPlace? _saved;
  ({double lat, double lng})? _here;
  bool _locating = false;
  final _notes = TextEditingController();
  String? _error;

  // A repeated tap or a retry after a bad connection must never make two bookings.
  late final String _bookingId = _state.newId();

  @override
  void dispose() {
    _notes.dispose();
    super.dispose();
  }

  Future<(List<ServiceType>, List<SavedPlace>)> _load() async {
    final services = await _state.api.bookingServices();
    List<SavedPlace> places = const [];
    try {
      places = await _state.api.places();
    } catch (_) {}
    return (services, places);
  }

  void _reload() => setState(() => _future = _load());

  DateTime get _startAt => DateTime(_date.year, _date.month, _date.day, _start.hour, _start.minute);

  Future<void> _pickDate() async {
    final now = DateTime.now();
    final d = await showDatePicker(
      context: context,
      initialDate: _date.isBefore(now) ? now : _date,
      firstDate: DateTime(now.year, now.month, now.day),
      lastDate: now.add(const Duration(days: 60)),
    );
    if (d != null) setState(() => _date = d);
  }

  Future<void> _pickTime() async {
    final t = await showTimePicker(context: context, initialTime: _start);
    if (t != null) setState(() => _start = t);
  }

  Future<void> _useHere() async {
    setState(() {
      _locating = true;
      _error = null;
    });
    try {
      if (!await Geolocator.isLocationServiceEnabled()) {
        return setState(() => _error = 'Location is turned off on this phone. Turn it on and try again.');
      }
      var permission = await Geolocator.checkPermission();
      if (permission == LocationPermission.denied) permission = await Geolocator.requestPermission();
      if (permission == LocationPermission.denied || permission == LocationPermission.deniedForever) {
        return setState(() => _error = 'Location is not allowed. Allow it in Settings → App Permissions.');
      }
      final pos = await Geolocator.getCurrentPosition(
        locationSettings: const LocationSettings(accuracy: LocationAccuracy.high, timeLimit: Duration(seconds: 20)),
      );
      if (mounted) {
        setState(() {
          _here = (lat: pos.latitude, lng: pos.longitude);
          _saved = null;
        });
      }
    } catch (_) {
      if (mounted) setState(() => _error = 'Could not get your location. Go near a window or outside and try again.');
    } finally {
      if (mounted) setState(() => _locating = false);
    }
  }

  Future<void> _send() async {
    final service = _service;
    if (service == null) return setState(() => _error = 'Choose a service.');
    if (_saved == null && _here == null) return setState(() => _error = 'Choose where you need the Rakshak.');
    final start = _startAt;
    if (!start.isAfter(DateTime.now())) return setState(() => _error = 'Choose a time in the future.');
    setState(() => _error = null);
    try {
      final b = await _state.api.createBooking(
        id: _bookingId,
        serviceType: service.id,
        windowStart: start,
        windowEnd: start.add(Duration(hours: _hours)),
        lat: _saved?.lat ?? _here!.lat,
        lng: _saved?.lng ?? _here!.lng,
        label: _saved == null ? 'My current location' : (_saved!.address ?? _saved!.name),
        notes: _notes.text,
      );
      if (!mounted) return;
      await Navigator.pushReplacement(context, MaterialPageRoute(builder: (_) => BookingDetailScreen(booking: b)));
    } catch (e) {
      if (!mounted) return;
      if (phase3Unavailable(e)) {
        setState(() => _error = 'Booking is not available yet. We will let you know when it is.');
      } else {
        showError(context, e);
      }
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: const Text('Book a Rakshak')),
        body: FutureBuilder<(List<ServiceType>, List<SavedPlace>)>(
          future: _future,
          builder: (context, snap) {
            if (snap.connectionState != ConnectionState.done) return const Center(child: CircularProgressIndicator());
            if (snap.hasError) {
              return phase3Unavailable(snap.error!) ? NotAvailableYet(onRetry: _reload) : LoadFailed(error: snap.error!, onRetry: _reload);
            }
            final (services, places) = snap.data!;
            if (services.isEmpty) return NotAvailableYet(onRetry: _reload);
            return _form(services, places);
          },
        ),
      );

  Widget _form(List<ServiceType> services, List<SavedPlace> places) {
    final end = _startAt.add(Duration(hours: _hours));
    return ListView(padding: const EdgeInsets.fromLTRB(20, 4, 20, 32), children: [
      const SectionLabel('Service'),
      for (final s in services)
        Padding(
          padding: const EdgeInsets.only(bottom: 10),
          child: AppCard(
            onTap: () => setState(() => _service = s),
            color: _service?.id == s.id ? AppColors.redSoft : null,
            child: Row(children: [
              Icon(_service?.id == s.id ? Icons.radio_button_checked : Icons.radio_button_off,
                  color: _service?.id == s.id ? AppColors.red : AppColors.muted),
              const SizedBox(width: 12),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text(s.name, style: const TextStyle(fontSize: 16.5, fontWeight: FontWeight.w700)),
                  if (s.description.isNotEmpty)
                    Padding(
                      padding: const EdgeInsets.only(top: 2),
                      child: Text(s.description, style: const TextStyle(color: AppColors.muted, height: 1.35)),
                    ),
                ]),
              ),
            ]),
          ),
        ),
      const SizedBox(height: 12),
      const SectionLabel('When'),
      Row(children: [
        Expanded(child: OutlinedButton.icon(onPressed: _pickDate, icon: const Icon(Icons.calendar_today_outlined, size: 18), label: Text(_dayText(_date)))),
        const SizedBox(width: 10),
        Expanded(child: OutlinedButton.icon(onPressed: _pickTime, icon: const Icon(Icons.schedule, size: 18), label: Text(_start.format(context)))),
      ]),
      const SizedBox(height: 10),
      Wrap(spacing: 8, runSpacing: 8, children: [
        for (final h in const [1, 2, 3, 4, 8]) PillChoice(label: '$h h', selected: h == _hours, onSelected: (_) => setState(() => _hours = h)),
      ]),
      const SizedBox(height: 6),
      Text('From ${windowText(_startAt, end)}', style: const TextStyle(color: AppColors.muted, fontSize: 13.5)),
      const SizedBox(height: 18),
      const SectionLabel('Where'),
      Wrap(spacing: 8, runSpacing: 8, children: [
        PillChoice(
          label: _locating ? 'Finding you…' : 'My current location',
          icon: Icons.my_location,
          selected: _here != null && _saved == null,
          onSelected: (_) => _locating ? null : _useHere(),
        ),
        for (final p in places)
          PillChoice(
            label: p.name,
            icon: p.label == 'home' ? Icons.home_outlined : p.label == 'work' ? Icons.work_outline : Icons.place_outlined,
            selected: _saved?.id == p.id,
            onSelected: (_) => setState(() {
              _saved = p;
              _here = null;
            }),
          ),
      ]),
      if (places.isEmpty)
        const Padding(
          padding: EdgeInsets.only(top: 8),
          child: Text('Tip: save Home and Work in Saved Places to pick them here.', style: TextStyle(color: AppColors.muted, fontSize: 13.5)),
        ),
      const SizedBox(height: 18),
      const SectionLabel('Notes for the Rakshak (optional)'),
      TextField(
        controller: _notes,
        maxLength: 300,
        maxLines: 3,
        textCapitalization: TextCapitalization.sentences,
        decoration: const InputDecoration(hintText: 'Anything the Rakshak should know'),
      ),
      if (_error != null) ...[
        const SizedBox(height: 8),
        NoticeBox(text: _error!, icon: Icons.error_outline, color: AppColors.redDark, background: AppColors.redSoft),
      ],
      const SizedBox(height: 12),
      BusyButton(label: 'Send request', onPressed: _send),
      const SizedBox(height: 10),
      const Text(
        'This sends a request. You will get a quote to accept before anything is confirmed.',
        textAlign: TextAlign.center,
        style: TextStyle(color: AppColors.muted, fontSize: 13.5, height: 1.4),
      ),
    ]);
  }

  String _dayText(DateTime d) {
    final now = DateTime.now();
    if (d.year == now.year && d.month == now.month && d.day == now.day) return 'Today';
    const m = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return '${d.day} ${m[d.month - 1]}';
  }
}
