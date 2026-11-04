import 'dart:async';

import 'package:flutter/material.dart';
import 'package:google_maps_flutter/google_maps_flutter.dart';

import '../../api/api_client.dart';
import '../../api/maps_service.dart';
import '../../api/models.dart';
import '../../config.dart';
import '../../state/app_state.dart';
import '../../theme.dart';
import '../../widgets/common.dart';
import '../../widgets/format.dart';
import '../home/shell.dart';
import 'journey_complete_screen.dart';

/// Journey on (design frame 10, without the "Safety score": Phase 1 has no score).
class JourneyOnScreen extends StatefulWidget {
  const JourneyOnScreen({super.key, required this.journeyId});
  final String journeyId;

  @override
  State<JourneyOnScreen> createState() => _JourneyOnScreenState();
}

class _JourneyOnScreenState extends State<JourneyOnScreen> {
  Journey? _journey;
  GoogleMapController? _map;
  Timer? _tick;

  @override
  void initState() {
    super.initState();
    _load();
    _tick = Timer.periodic(const Duration(seconds: 20), (_) => setState(() {}));
  }

  @override
  void dispose() {
    _tick?.cancel();
    _map?.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final j = await AppScope.read(context).api.journey(widget.journeyId);
      if (mounted) setState(() => _journey = j);
    } on ApiException catch (e) {
      if (mounted) showError(context, e);
    }
  }

  Future<void> _end({required bool arrived}) async {
    final state = AppScope.read(context);
    final ok = arrived ||
        await confirm(context, 'End journey?', 'Your guardians will be told you ended the journey (not that you arrived).', yes: 'End journey');
    if (!ok) return;
    try {
      final j = await state.api.endJourney(widget.journeyId, arrived: arrived);
      await state.engine.stopJourney();
      if (!mounted) return;
      if (arrived) {
        Navigator.pushReplacement(context, MaterialPageRoute(builder: (_) => JourneyCompleteScreen(journey: j)));
      } else {
        Navigator.of(context).popUntil((r) => r.isFirst);
      }
    } catch (e) {
      if (mounted) showError(context, e);
    }
  }

  @override
  Widget build(BuildContext context) {
    final state = AppScope.of(context);
    final engine = state.engineState;
    final j = _journey;
    final accepted = state.guardians.where((g) => g.status == 'accepted').toList();
    final (statusText, statusColor) = switch (engine.journeyStatus) {
      'stopped' => ('Stopped', AppColors.amber),
      'off_route' => ('Off route', AppColors.amber),
      'late' => ('Running late', AppColors.red),
      _ => ('On route', AppColors.green),
    };

    return Scaffold(
      body: j == null
          ? const Center(child: CircularProgressIndicator())
          : Stack(children: [
              Positioned.fill(child: _mapOrFallback(j, engine.lastLat, engine.lastLng)),
              SafeArea(
                child: Padding(
                  padding: const EdgeInsets.all(14),
                  child: Container(
                    padding: const EdgeInsets.all(14),
                    decoration: BoxDecoration(color: AppColors.night.withValues(alpha: 0.92), borderRadius: BorderRadius.circular(16)),
                    child: Row(children: [
                      IconButton(
                        onPressed: () => Navigator.pop(context),
                        icon: const Icon(Icons.chevron_left, color: Colors.white),
                      ),
                      Expanded(
                        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                          const Text('Journey in Progress', style: TextStyle(color: Colors.white, fontSize: 18, fontWeight: FontWeight.w700)),
                          Text('To ${j.destination.label} · reach by ${clock(j.expectedArrivalAt)}',
                              style: const TextStyle(color: Colors.white70)),
                        ]),
                      ),
                    ]),
                  ),
                ),
              ),
              Align(
                alignment: Alignment.bottomCenter,
                child: Container(
                  padding: const EdgeInsets.fromLTRB(20, 14, 20, 20),
                  decoration: const BoxDecoration(
                    color: AppColors.cream,
                    borderRadius: BorderRadius.vertical(top: Radius.circular(26)),
                  ),
                  child: SafeArea(
                    top: false,
                    child: Column(mainAxisSize: MainAxisSize.min, children: [
                      Container(width: 40, height: 4, decoration: BoxDecoration(color: AppColors.line, borderRadius: BorderRadius.circular(2))),
                      const SizedBox(height: 14),
                      Row(children: [
                        _Fact(title: 'Status', value: statusText, color: statusColor),
                        _Fact(title: 'Guardians', value: '${accepted.length} following'),
                        _Fact(title: 'Time left', value: _left(j.expectedArrivalAt)),
                      ]),
                      if (!engine.online)
                        const Padding(
                          padding: EdgeInsets.only(top: 10),
                          child: Text('No internet — your location is saved and sent when you are back online.',
                              style: TextStyle(color: AppColors.amber, fontWeight: FontWeight.w600)),
                        ),
                      const SizedBox(height: 14),
                      Row(children: [
                        Expanded(
                          child: OutlinedButton(
                            onPressed: () => state.engine.previewCheckin(),
                            child: const Text('Preview check-in'),
                          ),
                        ),
                        const SizedBox(width: 12),
                        SosHoldButton(size: 54, journeyId: j.id),
                      ]),
                      const SizedBox(height: 12),
                      BusyButton(label: 'I reached safely', color: AppColors.green, onPressed: () => _end(arrived: true)),
                      TextButton(onPressed: () => _end(arrived: false), child: const Text('End journey')),
                    ]),
                  ),
                ),
              ),
            ]),
    );
  }

  String _left(DateTime by) {
    final m = by.difference(DateTime.now()).inMinutes;
    return m >= 0 ? '$m min' : '${-m} min late';
  }

  Widget _mapOrFallback(Journey j, double? lat, double? lng) {
    if (AppConfig.mapsApiKey.isEmpty) {
      return Container(
        color: const Color(0xFF1E232B),
        alignment: Alignment.center,
        padding: const EdgeInsets.all(32),
        child: Text(
          lat == null ? 'Waiting for your location…' : 'You: ${lat.toStringAsFixed(5)}, ${lng!.toStringAsFixed(5)}\n(map needs a Google Maps key)',
          textAlign: TextAlign.center,
          style: const TextStyle(color: Colors.white70),
        ),
      );
    }
    final dest = LatLng(j.destination.lat, j.destination.lng);
    final route = j.route == null ? const <LatLng>[] : decodePolyline(j.route!).map((p) => LatLng(p.$1, p.$2)).toList();
    return GoogleMap(
      initialCameraPosition: CameraPosition(target: lat == null ? dest : LatLng(lat, lng!), zoom: 14),
      myLocationEnabled: true,
      myLocationButtonEnabled: false,
      zoomControlsEnabled: false,
      padding: const EdgeInsets.only(top: 100, bottom: 300),
      onMapCreated: (c) => _map = c,
      markers: {Marker(markerId: const MarkerId('dest'), position: dest, infoWindow: InfoWindow(title: j.destination.label))},
      polylines: {
        if (route.isNotEmpty) Polyline(polylineId: const PolylineId('route'), points: route, color: AppColors.red, width: 5),
      },
    );
  }
}

class _Fact extends StatelessWidget {
  const _Fact({required this.title, required this.value, this.color});
  final String title;
  final String value;
  final Color? color;

  @override
  Widget build(BuildContext context) => Expanded(
        child: Column(children: [
          Text(title, style: const TextStyle(color: AppColors.muted, fontSize: 13)),
          const SizedBox(height: 4),
          Text(value, textAlign: TextAlign.center, style: TextStyle(fontWeight: FontWeight.w700, fontSize: 16, color: color ?? AppColors.ink)),
        ]),
      );
}
