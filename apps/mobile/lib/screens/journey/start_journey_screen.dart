import 'dart:async';

import 'package:flutter/material.dart';
import 'package:geolocator/geolocator.dart';
import 'package:permission_handler/permission_handler.dart' show openAppSettings;

import '../../api/api_client.dart';
import '../../api/maps_service.dart';
import '../../api/models.dart';
import '../../state/app_state.dart';
import '../../theme.dart';
import '../../widgets/common.dart';
import '../../widgets/format.dart';
import '../settings/settings_screen.dart' show SavedPlacesScreen;
import 'journey_on_screen.dart';

/// Start journey (design: "Plan Your Journey"). Plan v2: no travel mode; every journey is shared
/// with all accepted guardians. "Reach by" defaults to Google's travel time + 10 minutes.
class StartJourneyScreen extends StatefulWidget {
  const StartJourneyScreen({super.key, this.preset, this.maps});
  final SavedPlace? preset;

  /// For tests; normally the real Google services.
  final MapsService? maps;

  @override
  State<StartJourneyScreen> createState() => _StartJourneyScreenState();
}

class _StartJourneyScreenState extends State<StartJourneyScreen> {
  late final MapsService _maps = widget.maps ?? MapsService();
  final _search = TextEditingController();
  Timer? _debounce;
  Position? _here;

  /// The address at [_here], so the user sees which location was found.
  String? _hereAddress;

  /// Why there is no location yet: null while looking, else a short message.
  String? _hereProblem;
  bool _hereNeedsSettings = false;
  List<SavedPlace> _saved = const [];
  List<PlaceResult> _results = const [];
  bool _searching = false;
  String? _searchError;
  Place? _destination;
  RouteResult? _route;
  DateTime? _arriveBy;

  @override
  void initState() {
    super.initState();
    _init();
  }

  @override
  void dispose() {
    _debounce?.cancel();
    _search.dispose();
    super.dispose();
  }

  Future<void> _init() async {
    await _loadSaved();
    await _findHere();
    if (widget.preset != null) {
      await _choose(Place(lat: widget.preset!.lat, lng: widget.preset!.lng, label: widget.preset!.name));
    }
    if (mounted) setState(() {});
  }

  Future<void> _loadSaved() async {
    try {
      _saved = await AppScope.read(context).api.places();
    } catch (_) {}
  }

  /// Current location: asks for permission if needed, says what is wrong, can be tried again.
  Future<void> _findHere() async {
    setState(() {
      _hereProblem = null;
      _hereNeedsSettings = false;
    });
    try {
      if (!await Geolocator.isLocationServiceEnabled()) {
        return _noHere('Location is turned off on this phone. Turn it on, then tap to try again.');
      }
      var permission = await Geolocator.checkPermission();
      if (permission == LocationPermission.denied) permission = await Geolocator.requestPermission();
      if (permission == LocationPermission.denied || permission == LocationPermission.deniedForever) {
        return _noHere('Location is not allowed for Sarthi Rakshak.', settings: true);
      }
      // A recent known position shows at once; then a fresh one.
      final last = await Geolocator.getLastKnownPosition();
      if (last != null && mounted) setState(() => _here = last);
      final fresh = await Geolocator.getCurrentPosition(
        locationSettings: const LocationSettings(accuracy: LocationAccuracy.high, timeLimit: Duration(seconds: 25)),
      );
      if (mounted) setState(() => _here = fresh);
      final address = await _maps.addressAt(fresh.latitude, fresh.longitude);
      if (mounted) setState(() => _hereAddress = address);
    } catch (_) {
      if (_here == null) _noHere('Could not find your location yet. Go near a window or outside, then tap to try again.');
    }
  }

  void _noHere(String problem, {bool settings = false}) {
    if (!mounted) return;
    setState(() {
      _hereProblem = problem;
      _hereNeedsSettings = settings;
    });
  }

  Future<void> _addPlace() async {
    await Navigator.push(context, MaterialPageRoute(builder: (_) => const SavedPlacesScreen()));
    await _loadSaved();
    if (mounted) setState(() {});
  }

  void _onSearch(String text) {
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 400), () async {
      if (!_maps.canSearch) return;
      setState(() {
        _searching = true;
        _searchError = null;
      });
      try {
        final r = await _maps.search(text, nearLat: _here?.latitude, nearLng: _here?.longitude);
        if (mounted) setState(() => _results = r);
      } catch (_) {
        if (mounted) setState(() => _searchError = 'Search isn’t working. Check your internet.');
      } finally {
        if (mounted) setState(() => _searching = false);
      }
    });
  }

  Future<void> _choose(Place place) async {
    setState(() {
      _destination = place;
      _results = const [];
      _search.text = place.label;
      _route = null;
      _arriveBy = DateTime.now().add(const Duration(minutes: 40));
    });
    FocusScope.of(context).unfocus();
    if (_here != null) {
      final route = await _maps.route(_here!.latitude, _here!.longitude, place).catchError((_) => null);
      if (!mounted) return;
      setState(() {
        _route = route;
        if (route != null) _arriveBy = DateTime.now().add(route.duration + const Duration(minutes: 10));
      });
    }
  }

  Future<void> _pickTime() async {
    final now = DateTime.now();
    final initial = _arriveBy ?? now.add(const Duration(minutes: 40));
    final t = await showTimePicker(context: context, initialTime: TimeOfDay.fromDateTime(initial));
    if (t == null) return;
    var picked = DateTime(now.year, now.month, now.day, t.hour, t.minute);
    if (picked.isBefore(now)) picked = picked.add(const Duration(days: 1));
    final ahead = picked.difference(now);
    if (ahead < const Duration(minutes: 5) || ahead > const Duration(hours: 12)) {
      if (mounted) showInfo(context, 'Choose a time within the next 12 hours (at least 5 minutes from now).');
      return;
    }
    setState(() => _arriveBy = picked);
  }

  Future<void> _start() async {
    final state = AppScope.read(context);
    final dest = _destination!;
    try {
      final journey = await state.api.startJourney(state.newId(), dest, _arriveBy!, _route?.polyline.isEmpty ?? true ? null : _route!.polyline);
      await state.engine.startJourney(journey: journey, rules: state.me?.rules ?? const {});
      if (!mounted) return;
      Navigator.pushReplacement(context, MaterialPageRoute(builder: (_) => JourneyOnScreen(journeyId: journey.id)));
    } on ApiException catch (e) {
      if (mounted) showError(context, e);
    }
  }

  @override
  Widget build(BuildContext context) {
    final state = AppScope.of(context);
    final accepted = state.guardians.where((g) => g.status == 'accepted').length;
    final canStart = _destination != null && _arriveBy != null && accepted > 0;

    return Scaffold(
      appBar: AppBar(title: const Text('Plan Your Journey')),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(20, 8, 20, 24),
        children: [
          AppCard(
            onTap: _hereProblem == null ? null : (_hereNeedsSettings ? openAppSettings : _findHere),
            child: Row(children: [
              const CircleAvatar(backgroundColor: Color(0xFFE6F0FF), child: Icon(Icons.location_on, color: Color(0xFF1D6FE8))),
              const SizedBox(width: 12),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  const Text('Your Current Location', style: TextStyle(fontWeight: FontWeight.w700, fontSize: 16)),
                  if (_here != null && _hereAddress != null)
                    Text(_hereAddress!, key: const Key('here-address'), maxLines: 2, overflow: TextOverflow.ellipsis),
                  Text(
                    _here != null
                        ? '${_hereAddress == null ? '${_here!.latitude.toStringAsFixed(5)}, ${_here!.longitude.toStringAsFixed(5)} · ' : ''}'
                            'accurate to ${_here!.accuracy.round()} m'
                        : _hereProblem ?? 'Finding your location…',
                    style: TextStyle(color: _here == null && _hereProblem != null ? AppColors.red : AppColors.muted),
                  ),
                  if (_here == null && _hereProblem != null)
                    Text(_hereNeedsSettings ? 'Tap to open App permissions' : 'Tap to try again',
                        style: const TextStyle(color: AppColors.red, fontWeight: FontWeight.w600)),
                ]),
              ),
            ]),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _search,
            onChanged: _onSearch,
            decoration: InputDecoration(
              prefixIcon: const Icon(Icons.location_on, color: AppColors.red),
              hintText: _maps.canSearch ? 'Search destination (area, place, address)' : 'Pick a saved place below',
              enabled: _maps.canSearch,
              suffixIcon: _searching ? const Padding(padding: EdgeInsets.all(14), child: CircularProgressIndicator(strokeWidth: 2)) : null,
            ),
          ),
          if (_searchError != null)
            Padding(padding: const EdgeInsets.only(top: 8), child: Text(_searchError!, style: const TextStyle(color: AppColors.red))),
          if (_results.isNotEmpty)
            AppCard(
              padding: EdgeInsets.zero,
              child: Column(children: [
                for (final r in _results)
                  ListTile(
                    leading: const Icon(Icons.place_outlined),
                    title: Text(r.name),
                    subtitle: Text(r.address, maxLines: 1, overflow: TextOverflow.ellipsis),
                    onTap: () => _choose(Place(lat: r.lat, lng: r.lng, label: r.name)),
                  ),
              ]),
            )
          else if (_search.text.length > 2 && !_searching && _destination == null && _maps.canSearch)
            const Padding(padding: EdgeInsets.only(top: 8), child: Text('No places found', style: TextStyle(color: AppColors.muted))),
          const SizedBox(height: 16),
          if (_destination != null)
            AppCard(
              onTap: _pickTime,
              child: Row(children: [
                const Icon(Icons.schedule, color: AppColors.muted),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    const Text('Reach by', style: TextStyle(color: AppColors.muted)),
                    Text(_arriveBy == null ? '—' : clock(_arriveBy!), style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w700)),
                    if (_route != null)
                      Text('About ${_route!.duration.inMinutes} min · ${(_route!.distanceM / 1000).toStringAsFixed(1)} km by road',
                          style: const TextStyle(color: AppColors.muted)),
                  ]),
                ),
                const Text('Change', style: TextStyle(color: AppColors.red, fontWeight: FontWeight.w600)),
              ]),
            ),
          const SizedBox(height: 16),
          BusyButton(label: 'Start journey', onPressed: canStart ? _start : null),
          if (accepted == 0)
            const Padding(
              padding: EdgeInsets.only(top: 8),
              child: Text('At least one guardian must accept your invite first.', style: TextStyle(color: AppColors.red)),
            ),
          const SizedBox(height: 22),
          if (_saved.isEmpty && !_maps.canSearch)
            AppCard(
              color: AppColors.amberSoft,
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                const Text('No saved places yet',
                    style: TextStyle(color: AppColors.amber, fontWeight: FontWeight.w700, fontSize: 16)),
                const SizedBox(height: 4),
                const Text(
                  'Place search is not available in this test build. Save places you go to (Home, Office…): '
                  'when you are there, open Saved places and tap “Use my current location”.',
                  style: TextStyle(color: AppColors.ink),
                ),
                const SizedBox(height: 8),
                OutlinedButton.icon(
                  key: const Key('add-place'),
                  onPressed: _addPlace,
                  icon: const Icon(Icons.add_location_alt_outlined),
                  label: const Text('Add a saved place'),
                ),
              ]),
            ),
          if (_saved.isNotEmpty) ...[
            const Text('Saved places', style: TextStyle(fontSize: 19, fontWeight: FontWeight.w700)),
            const SizedBox(height: 8),
            for (final p in _saved)
              ListTile(
                contentPadding: EdgeInsets.zero,
                leading: CircleAvatar(
                  backgroundColor: AppColors.redSoft,
                  child: Icon(p.label == 'home' ? Icons.home : p.label == 'work' ? Icons.work : Icons.place, color: AppColors.red),
                ),
                title: Text(p.name, style: const TextStyle(fontWeight: FontWeight.w600)),
                subtitle: p.address == null ? null : Text(p.address!, maxLines: 1, overflow: TextOverflow.ellipsis),
                trailing: const Icon(Icons.chevron_right),
                onTap: () => _choose(Place(lat: p.lat, lng: p.lng, label: p.name)),
              ),
          ],
        ],
      ),
    );
  }
}
