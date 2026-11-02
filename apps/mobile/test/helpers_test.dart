import 'package:flutter_test/flutter_test.dart';
import 'package:sarthi_rakshak/api/maps_service.dart';
import 'package:sarthi_rakshak/screens/auth/profile_screen.dart';
import 'package:sarthi_rakshak/widgets/format.dart';

void main() {
  test('Indian mobile numbers in any common form', () {
    for (final v in ['98123 44521', '+91 98123 44521', '098123 44521', '919812344521', '+91-98123-44521']) {
      expect(normaliseIndianMobile(v), '+919812344521', reason: v);
    }
    for (final v in ['12345', '58123 44521', '+1 202 555 0100', '98123445210']) {
      expect(normaliseIndianMobile(v), isNull, reason: v);
    }
  });

  test('name rule matches the server (any language)', () {
    expect(ProfileScreenTestHook.check('Priya Sharma'), isNull);
    expect(ProfileScreenTestHook.check('प्रिया शर्मा'), isNull);
    expect(ProfileScreenTestHook.check("D'Souza"), isNull);
    expect(ProfileScreenTestHook.check('A'), isNotNull);
    expect(ProfileScreenTestHook.check('Priya 2'), isNotNull);
    expect(ProfileScreenTestHook.check('-Priya'), isNotNull);
    expect(ProfileScreenTestHook.check('x' * 51), isNotNull);
  });

  test('decodes Google encoded polylines', () {
    final pts = decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
    expect(pts.length, 3);
    expect(pts[0].$1, closeTo(38.5, 1e-6));
    expect(pts[0].$2, closeTo(-120.2, 1e-6));
    expect(pts[2].$1, closeTo(43.252, 1e-6));
    expect(pts[2].$2, closeTo(-126.453, 1e-6));
  });

  test('time ago', () {
    final now = DateTime(2026, 11, 2, 12);
    expect(ago(now.subtract(const Duration(seconds: 20)), now), 'just now');
    expect(ago(now.subtract(const Duration(minutes: 3)), now), '3 min ago');
    expect(ago(now.subtract(const Duration(hours: 2)), now), '2 h ago');
  });
}
