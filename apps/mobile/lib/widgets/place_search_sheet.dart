import 'dart:async';

import 'package:flutter/material.dart';
import 'package:geolocator/geolocator.dart';

import '../api/maps_service.dart';
import '../theme.dart';

/// Search any place by name or address and pick one (e.g. where a Rakshak is needed). Places are
/// listed while typing, nearest first. Returns null if closed without choosing.
Future<PlaceResult?> showPlaceSearch(BuildContext context, {MapsService? maps}) =>
    showModalBottomSheet<PlaceResult>(
      context: context,
      isScrollControlled: true,
      backgroundColor: AppColors.cream,
      builder: (_) => PlaceSearchSheet(maps: maps),
    );

class PlaceSearchSheet extends StatefulWidget {
  const PlaceSearchSheet({super.key, this.maps});
  final MapsService? maps;

  @override
  State<PlaceSearchSheet> createState() => _PlaceSearchSheetState();
}

class _PlaceSearchSheetState extends State<PlaceSearchSheet> {
  late final MapsService _maps = widget.maps ?? MapsService();
  final _text = TextEditingController();
  List<PlaceResult> _results = const [];
  bool _searching = false;
  bool _searched = false;
  String? _error;
  Timer? _typing;
  int _searchNo = 0;
  Position? _near;

  static const _typingPause = Duration(milliseconds: 500);
  static const _minLetters = 3;

  @override
  void initState() {
    super.initState();
    _lastKnownPlace();
  }

  /// Where the phone last was (no prompt, no waiting): places near it are listed first.
  Future<void> _lastKnownPlace() async {
    try {
      final p = await Geolocator.checkPermission();
      if (p != LocationPermission.always && p != LocationPermission.whileInUse) return;
      _near = await Geolocator.getLastKnownPosition();
    } catch (_) {
      // Searched across India instead.
    }
  }

  @override
  void dispose() {
    _typing?.cancel();
    _text.dispose();
    super.dispose();
  }

  void _onTyping(String text) {
    _typing?.cancel();
    if (text.trim().length < _minLetters) {
      _searchNo++;
      setState(() {
        _results = const [];
        _searched = false;
        _searching = false;
      });
      return;
    }
    _typing = Timer(_typingPause, _find);
  }

  Future<void> _find() async {
    _typing?.cancel();
    final text = _text.text.trim();
    if (text.length < 2) return setState(() => _error = 'Type at least 2 letters of the place or address.');
    final no = ++_searchNo;
    setState(() {
      _searching = true;
      _error = null;
    });
    try {
      final r = await _maps.search(text, nearLat: _near?.latitude, nearLng: _near?.longitude);
      if (mounted && no == _searchNo) setState(() => _results = r);
    } catch (_) {
      if (mounted && no == _searchNo) setState(() => _error = 'Search isn’t working. Check your internet.');
    } finally {
      if (mounted && no == _searchNo) {
        setState(() {
          _searching = false;
          _searched = true;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) => Padding(
        padding: EdgeInsets.fromLTRB(20, 20, 20, 20 + MediaQuery.of(context).viewInsets.bottom),
        child: SingleChildScrollView(
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            const Text('Choose a place', style: TextStyle(fontSize: 22, fontWeight: FontWeight.w800)),
            const SizedBox(height: 14),
            TextField(
              key: const Key('place-search-sheet'),
              controller: _text,
              autofocus: true,
              textInputAction: TextInputAction.search,
              decoration: InputDecoration(
                prefixIcon: const Icon(Icons.search),
                hintText: 'Search area, place or address',
                suffixIcon: _searching
                    ? const Padding(padding: EdgeInsets.all(14), child: CircularProgressIndicator(strokeWidth: 2))
                    : null,
              ),
              onChanged: _onTyping,
              onSubmitted: (_) => _find(),
            ),
            if (_searched && _results.isEmpty && !_searching)
              const Padding(
                padding: EdgeInsets.only(top: 8),
                child: Text('No places found. Try the area and city, e.g. “Sector 18, Noida”.',
                    style: TextStyle(color: AppColors.muted)),
              ),
            if (_results.isNotEmpty)
              const Padding(
                padding: EdgeInsets.only(top: 8, left: 4),
                child: Text('Tap the right place:', style: TextStyle(color: AppColors.muted, fontSize: 13)),
              ),
            for (final r in _results.take(6))
              ListTile(
                leading: const Icon(Icons.place_outlined, color: AppColors.muted),
                title: Text(r.name),
                subtitle: Text(r.address, maxLines: 2, overflow: TextOverflow.ellipsis),
                onTap: () => Navigator.pop(context, r),
              ),
            if (_error != null)
              Padding(padding: const EdgeInsets.only(top: 8), child: Text(_error!, style: const TextStyle(color: AppColors.red))),
          ]),
        ),
      );
}
