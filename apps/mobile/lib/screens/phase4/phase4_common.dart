import 'package:flutter/material.dart';
import 'package:geolocator/geolocator.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../api/phase4_api.dart';
import '../../theme.dart';
import '../../widgets/common.dart';
import '../phase3/phase3_common.dart';

const p4NotMedical = 'This is general safety information. It is not medical or legal advice.';

/// Loads something from the server and shows it, or "not available yet", or a retry.
class P4Loader<T> extends StatefulWidget {
  const P4Loader({super.key, required this.load, required this.builder});
  final Future<T> Function() load;
  final Widget Function(BuildContext, T, Future<void> Function() reload) builder;

  @override
  State<P4Loader<T>> createState() => _P4LoaderState<T>();
}

class _P4LoaderState<T> extends State<P4Loader<T>> {
  late Future<T> _f = widget.load();

  Future<void> _reload() async {
    final f = widget.load();
    setState(() => _f = f);
    try {
      await f;
    } catch (_) {}
  }

  @override
  Widget build(BuildContext context) => FutureBuilder<T>(
        future: _f,
        builder: (c, snap) {
          if (snap.connectionState != ConnectionState.done) return const Center(child: CircularProgressIndicator());
          if (snap.hasError) {
            return phase4Unavailable(snap.error!) ? NotAvailableYet(onRetry: _reload) : LoadFailed(error: snap.error!, onRetry: _reload);
          }
          return widget.builder(c, snap.data as T, _reload);
        },
      );
}

Future<void> p4Call(BuildContext context, String? phone) async {
  if (phone == null || phone.isEmpty) return;
  final ok = await launchUrl(Uri.parse('tel:$phone'));
  if (!ok && context.mounted) showInfo(context, 'Could not open the phone app.');
}

Future<void> p4Directions(BuildContext context, double lat, double lng) async {
  final ok = await launchUrl(Uri.parse('https://www.google.com/maps/dir/?api=1&destination=$lat,$lng'),
      mode: LaunchMode.externalApplication);
  if (!ok && context.mounted) showInfo(context, 'Could not open maps.');
}

/// The phone's position, or null with a plain reason.
Future<(Position?, String?)> p4Position() async {
  try {
    if (!await Geolocator.isLocationServiceEnabled()) return (null, 'Location is switched off on this phone.');
    var perm = await Geolocator.checkPermission();
    if (perm == LocationPermission.denied) perm = await Geolocator.requestPermission();
    if (perm == LocationPermission.denied || perm == LocationPermission.deniedForever) {
      return (null, 'Allow location for Sarthi Rakshak to see places near you.');
    }
    final p = await Geolocator.getCurrentPosition(locationSettings: const LocationSettings(timeLimit: Duration(seconds: 12)));
    return (p, null);
  } catch (_) {
    return (null, 'Could not get your location. Please try again.');
  }
}

String p4Distance(num m) => m < 1000 ? '${m.round()} m' : '${(m / 1000).toStringAsFixed(1)} km';

String p4Label(String s) {
  if (s.isEmpty) return s;
  final t = s.replaceAll('_', ' ');
  return t[0].toUpperCase() + t.substring(1);
}

/// A card with a title, steps or text, used by guidance and notices.
class P4Disclaimer extends StatelessWidget {
  const P4Disclaimer(this.text, {super.key});
  final String text;
  @override
  Widget build(BuildContext context) =>
      Padding(padding: const EdgeInsets.only(top: 8), child: Text(text, style: const TextStyle(color: AppColors.muted, fontSize: 13, height: 1.35)));
}
