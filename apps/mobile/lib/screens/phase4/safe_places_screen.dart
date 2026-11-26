import 'package:flutter/material.dart';
import 'package:geolocator/geolocator.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../api/phase4_api.dart';
import '../../state/app_state.dart';
import '../../theme.dart';
import '../../widgets/common.dart';
import '../phase3/phase3_common.dart';
import 'phase4_common.dart';

/// Safe Place Finder: police, hospitals, pharmacies, petrol pumps, help desks and verified partners
/// near you. A listing is information, not a guarantee that the place is open or safe.
class SafePlacesScreen extends StatefulWidget {
  const SafePlacesScreen({super.key});
  @override
  State<SafePlacesScreen> createState() => _SafePlacesScreenState();
}

class _SafePlacesScreenState extends State<SafePlacesScreen> {
  late final AppState _state = AppScope.read(context);
  static const _cats = {
    null: 'All',
    'police': 'Police',
    'hospital': 'Hospital',
    'pharmacy': 'Pharmacy',
    'petrol': 'Petrol pump',
    'help_desk': 'Help desk',
    'partner': 'Partners',
  };
  String? _cat;
  Position? _pos;
  SafePlaceReply? _reply;
  Object? _error;
  String? _problem;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() { _loading = true; _error = null; _problem = null; });
    if (_pos == null) {
      final (p, why) = await p4Position();
      _pos = p;
      _problem = why;
    }
    if (_pos != null) {
      try {
        _reply = await _state.api.safePlaces(_pos!.latitude, _pos!.longitude, category: _cat);
      } catch (e) {
        _error = e;
      }
    }
    if (mounted) setState(() => _loading = false);
  }

  Future<void> _share(Map<String, dynamic> p) async {
    final url = 'https://www.google.com/maps/search/?api=1&query=${p['lat']},${p['lng']}';
    await launchUrl(Uri.parse('sms:?body=${Uri.encodeComponent("${p['name']}: $url")}'));
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: const Text('Safe places')),
        body: Column(children: [
          SizedBox(
            height: 56,
            child: ListView(scrollDirection: Axis.horizontal, padding: const EdgeInsets.all(8), children: [
              for (final e in _cats.entries)
                Padding(
                  padding: const EdgeInsets.only(right: 8),
                  child: PillChoice(label: e.value, selected: _cat == e.key, onSelected: (_) {
                    _cat = e.key;
                    _load();
                  }),
                ),
            ]),
          ),
          Expanded(child: _body()),
        ]),
      );

  Widget _body() {
    if (_loading) return const Center(child: CircularProgressIndicator());
    if (_problem != null) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            Text(_problem!, textAlign: TextAlign.center),
            const SizedBox(height: 12),
            OutlinedButton(onPressed: _load, child: const Text('Try again')),
          ]),
        ),
      );
    }
    if (_error != null) {
      return phase4Unavailable(_error!) ? NotAvailableYet(onRetry: _load) : LoadFailed(error: _error!, onRetry: _load);
    }
    final r = _reply!;
    return ListView(padding: const EdgeInsets.all(16), children: [
      if (!r.providerAvailable)
        NoticeBox(text: r.providerMessage ?? 'Map places are not available right now. Only verified partner places are shown.'),
      if (r.items.isEmpty) const EmptyState(icon: Icons.search_off, text: 'No places found nearby.'),
      for (final p in r.items)
        Padding(
          padding: const EdgeInsets.only(bottom: 10),
          child: AppCard(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Row(children: [
                Expanded(child: Text('${p['name']}', style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w700))),
                if (p['verified'] == true) const StatusPill('Verified partner', color: AppColors.green),
              ]),
              Text('${p4Label('${p['category']}')} · ${p4Distance((p['distanceM'] as num?) ?? 0)}', style: const TextStyle(color: AppColors.muted)),
              if (p['address'] != null) Text('${p['address']}'),
              if (p['hours'] != null) Text('Hours: ${p['hours']}', style: const TextStyle(color: AppColors.muted)),
              if (p['openNow'] != null) Text(p['openNow'] == true ? 'Open now (as listed)' : 'Closed now (as listed)', style: const TextStyle(color: AppColors.muted)),
              if (p['services'] != null) Text('${p['services']}', style: const TextStyle(color: AppColors.muted)),
              const SizedBox(height: 8),
              Wrap(spacing: 8, children: [
                OutlinedButton.icon(onPressed: () => p4Directions(context, (p['lat'] as num).toDouble(), (p['lng'] as num).toDouble()), icon: const Icon(Icons.directions), label: const Text('Directions')),
                if (p['phone'] != null) OutlinedButton.icon(onPressed: () => p4Call(context, '${p['phone']}'), icon: const Icon(Icons.call), label: const Text('Call')),
                OutlinedButton.icon(onPressed: () => _share(p), icon: const Icon(Icons.share), label: const Text('Share')),
              ]),
            ]),
          ),
        ),
      P4Disclaimer(r.disclaimer ?? 'Listings may be out of date. A badge means we verified the place, not that you will be safe there. Call 112 in an emergency.'),
    ]);
  }
}
