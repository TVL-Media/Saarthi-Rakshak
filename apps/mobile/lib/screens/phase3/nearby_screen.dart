import 'dart:async';

import 'package:flutter/material.dart';
import 'package:geolocator/geolocator.dart';
import 'package:google_maps_flutter/google_maps_flutter.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../api/phase3_api.dart';
import '../../config.dart';
import '../../state/app_state.dart';
import '../../theme.dart';
import '../../widgets/common.dart';
import 'book_screen.dart';
import 'phase3_common.dart';

const _consentKey = 'p3_nearby_consent';

/// Rakshaks near me: verified Rakshaks who are online inside the radius, on a map and as a list.
/// Your position is used to find them and is not shared with a Rakshak until you book.
class NearbyScreen extends StatefulWidget {
  const NearbyScreen({super.key});

  @override
  State<NearbyScreen> createState() => _NearbyScreenState();
}

class _NearbyScreenState extends State<NearbyScreen> with WidgetsBindingObserver {
  late final AppState _state = AppScope.read(context);
  static const _radii = [1000, 2000, 3000, 5000];

  bool? _consent; // null while reading the saved answer
  int _radius = 2000;
  Position? _pos;
  NearbyReply? _reply;
  Object? _error;
  String? _locationProblem;
  bool _loading = false;
  bool _unavailable = false;
  Timer? _timer;
  GoogleMapController? _map;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _readConsent();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _timer?.cancel();
    _map?.dispose();
    super.dispose();
  }

  /// No refreshing (and no location use) while the app is in the background.
  @override
  void didChangeAppLifecycleState(AppLifecycleState s) {
    if (s == AppLifecycleState.resumed) {
      if (_consent == true) _refresh();
    } else {
      _timer?.cancel();
    }
  }

  Future<void> _readConsent() async {
    var ok = false;
    try {
      ok = (await SharedPreferences.getInstance()).getBool(_consentKey) ?? false;
    } catch (_) {}
    if (!mounted) return;
    setState(() => _consent = ok);
    if (ok) _refresh();
  }

  Future<void> _allow() async {
    try {
      await (await SharedPreferences.getInstance()).setBool(_consentKey, true);
    } catch (_) {}
    if (!mounted) return;
    setState(() => _consent = true);
    _refresh();
  }

  Future<bool> _locate() async {
    try {
      if (!await Geolocator.isLocationServiceEnabled()) {
        _locationProblem = 'Location is turned off on this phone. Turn it on to see Rakshaks near you.';
        return false;
      }
      var permission = await Geolocator.checkPermission();
      if (permission == LocationPermission.denied) permission = await Geolocator.requestPermission();
      if (permission == LocationPermission.denied || permission == LocationPermission.deniedForever) {
        _locationProblem = 'Location is not allowed. Allow it in Settings → App Permissions.';
        return false;
      }
      _pos = await Geolocator.getCurrentPosition(
        locationSettings: const LocationSettings(accuracy: LocationAccuracy.high, timeLimit: Duration(seconds: 20)),
      );
      _locationProblem = null;
      return true;
    } catch (_) {
      _locationProblem = 'Could not get your location. Go near a window or outside and try again.';
      return false;
    }
  }

  Future<void> _refresh() async {
    if (_loading || !mounted) return;
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      if (!await _locate()) return;
      final reply = await _state.api.nearbyRakshaks(_pos!.latitude, _pos!.longitude, _radius);
      if (!mounted) return;
      setState(() {
        _reply = reply;
        _unavailable = false;
        // Never ask for a radius the server will not serve.
        if (_radius > reply.maxRadiusM) _radius = reply.maxRadiusM;
      });
      _schedule(reply.refreshSeconds);
    } catch (e) {
      if (!mounted) return;
      if (phase3Unavailable(e)) {
        setState(() => _unavailable = true);
      } else {
        setState(() => _error = e);
        _schedule(60);
      }
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  void _schedule(int seconds) {
    _timer?.cancel();
    _timer = Timer(Duration(seconds: seconds), _refresh);
  }

  void _setRadius(int r) {
    setState(() => _radius = r);
    _refresh();
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: const Text('Rakshaks near me'), actions: [
          if (_consent == true)
            IconButton(tooltip: 'Refresh', onPressed: _loading ? null : _refresh, icon: const Icon(Icons.refresh)),
        ]),
        body: _body(),
      );

  Widget _body() {
    if (_consent == null) return const Center(child: CircularProgressIndicator());
    if (_consent == false) return _ConsentCard(onAllow: _allow);
    if (_unavailable) return NotAvailableYet(onRetry: _refresh);
    if (_locationProblem != null) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(28),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            const Icon(Icons.location_off_outlined, size: 44, color: AppColors.muted),
            const SizedBox(height: 12),
            Text(_locationProblem!, textAlign: TextAlign.center, style: const TextStyle(fontSize: 16, height: 1.4)),
            const SizedBox(height: 16),
            OutlinedButton(onPressed: _refresh, child: const Text('Try again')),
          ]),
        ),
      );
    }
    if (_error != null && _reply == null) return LoadFailed(error: _error!, onRetry: _refresh);
    final reply = _reply;
    if (reply == null) return const Center(child: CircularProgressIndicator());

    final radii = _radii.where((r) => r <= reply.maxRadiusM).toList();
    return ListView(padding: const EdgeInsets.fromLTRB(20, 4, 20, 32), children: [
      if (AppConfig.mapsApiKey.isNotEmpty && _pos != null) ...[
        ClipRRect(borderRadius: BorderRadius.circular(16), child: SizedBox(height: 260, child: _mapView(reply))),
        const SizedBox(height: 14),
      ],
      Wrap(spacing: 8, runSpacing: 8, children: [
        for (final r in radii) PillChoice(label: '${r ~/ 1000} km', selected: r == _radius, onSelected: (_) => _setRadius(r)),
      ]),
      const SizedBox(height: 14),
      if (_error != null) const Padding(padding: EdgeInsets.only(bottom: 10), child: NoticeBox(text: 'Could not refresh. Showing the last list.')),
      if (reply.items.isEmpty)
        EmptyState(
          icon: Icons.shield_outlined,
          text: 'No verified Rakshak is online within ${_radius ~/ 1000} km right now. Try a bigger distance.',
        )
      else ...[
        SectionLabel('${reply.items.length} nearby'),
        for (final r in reply.items)
          Padding(
            padding: const EdgeInsets.only(bottom: 10),
            child: AppCard(
              child: Row(children: [
                Initials(r.firstName, size: 44),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text(r.firstName, style: const TextStyle(fontSize: 16.5, fontWeight: FontWeight.w700)),
                    Text('${distanceText(r.distanceM)} away', style: const TextStyle(color: AppColors.muted)),
                  ]),
                ),
                if (r.etaMinutes != null) StatusPill('~${r.etaMinutes} min', color: AppColors.green),
              ]),
            ),
          ),
      ],
      const SizedBox(height: 8),
      const Text(
        'Shown: verified Rakshaks who are online. Names are first names only and positions are approximate.',
        style: TextStyle(color: AppColors.muted, fontSize: 13, height: 1.4),
      ),
      const SizedBox(height: 16),
      FilledButton.icon(
        onPressed: () => Navigator.pushReplacement(context, MaterialPageRoute(builder: (_) => const BookScreen())),
        icon: const Icon(Icons.add_task),
        label: const Text('Book a Rakshak'),
      ),
    ]);
  }

  Widget _mapView(NearbyReply reply) {
    final me = LatLng(_pos!.latitude, _pos!.longitude);
    return GoogleMap(
      key: ValueKey(_radius),
      initialCameraPosition: CameraPosition(target: me, zoom: _radius <= 1000 ? 15 : _radius <= 2000 ? 14 : 13),
      myLocationEnabled: true,
      myLocationButtonEnabled: false,
      zoomControlsEnabled: false,
      onMapCreated: (c) => _map = c,
      circles: {
        Circle(
          circleId: const CircleId('radius'),
          center: me,
          radius: _radius.toDouble(),
          strokeColor: AppColors.red,
          strokeWidth: 2,
          fillColor: AppColors.red.withValues(alpha: 0.06),
        ),
      },
      markers: {
        for (final r in reply.items)
          Marker(
            markerId: MarkerId(r.id),
            position: LatLng(r.lat, r.lng),
            infoWindow: InfoWindow(title: r.firstName, snippet: r.etaMinutes == null ? distanceText(r.distanceM) : '~${r.etaMinutes} min'),
          ),
      },
    );
  }
}

/// Plain words on what location is used for, before the phone asks for permission.
class _ConsentCard extends StatelessWidget {
  const _ConsentCard({required this.onAllow});
  final VoidCallback onAllow;

  @override
  Widget build(BuildContext context) => ListView(padding: const EdgeInsets.fromLTRB(20, 16, 20, 32), children: [
        const IconTile(Icons.my_location, size: 56),
        const SizedBox(height: 16),
        const Text('See Rakshaks near you', style: TextStyle(fontSize: 22, fontWeight: FontWeight.w800)),
        const SizedBox(height: 10),
        const Text(
          'To show verified Rakshaks who are online close to you, Sarthi Rakshak uses your phone\'s location while this screen is open.',
          style: TextStyle(fontSize: 16, height: 1.45),
        ),
        const SizedBox(height: 14),
        for (final t in const [
          'Your location is used only to find Rakshaks nearby.',
          'A Rakshak sees where you are only after you send a booking request.',
          'It is not used while this screen is closed.',
        ])
          Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
              const Icon(Icons.check_circle, size: 20, color: AppColors.green),
              const SizedBox(width: 10),
              Expanded(child: Text(t, style: const TextStyle(fontSize: 15.5, height: 1.4))),
            ]),
          ),
        const SizedBox(height: 18),
        FilledButton(onPressed: onAllow, child: const Text('Allow and show nearby')),
      ]);
}
