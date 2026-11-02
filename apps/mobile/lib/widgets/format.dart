import 'package:intl/intl.dart';

/// "11:28 pm"
String clock(DateTime t) => DateFormat('h:mm a').format(t.toLocal()).toLowerCase();

/// "12 Sep 2026, 6:40 pm"
String dateTime(DateTime t) => '${DateFormat('d MMM y').format(t.toLocal())}, ${clock(t)}';

/// "just now", "3 min ago"
String ago(DateTime t, [DateTime? now]) {
  final m = (now ?? DateTime.now()).difference(t).inMinutes;
  if (m < 1) return 'just now';
  if (m < 60) return '$m min ago';
  final h = m ~/ 60;
  return h < 24 ? '$h h ago' : DateFormat('d MMM').format(t.toLocal());
}

/// "Good morning" / "Good afternoon" / "Good evening"
String greeting([DateTime? now]) {
  final h = (now ?? DateTime.now()).hour;
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

/// Indian mobile typed in any common form → "+91XXXXXXXXXX", or null if it is not one.
String? normaliseIndianMobile(String input) {
  final digits = input.replaceAll(RegExp(r'[^0-9+]'), '');
  final m = RegExp(r'^(?:\+91|0091|91|0)?([6-9]\d{9})$').firstMatch(digits);
  return m == null ? null : '+91${m.group(1)}';
}

/// "+919876543210" → "+91 98765 43210" (other formats unchanged).
String prettyPhone(String phone) {
  final m = RegExp(r'^\+91(\d{5})(\d{5})$').firstMatch(phone);
  return m == null ? phone : '+91 ${m[1]} ${m[2]}';
}
