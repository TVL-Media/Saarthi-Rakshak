import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:sarthi_rakshak/api/api_client.dart';
import 'package:sarthi_rakshak/api/models.dart';
import 'package:sarthi_rakshak/api/phase3_api.dart';
import 'package:sarthi_rakshak/screens/phase3/book_screen.dart';
import 'package:sarthi_rakshak/screens/phase3/bookings_screen.dart';
import 'package:sarthi_rakshak/screens/phase3/phase3_common.dart';
import 'package:sarthi_rakshak/state/app_state.dart';
import 'package:sarthi_rakshak/theme.dart';

import 'api_client_test.dart' as fixtures;

final calls = <http.Request>[];

Map<String, Object?> bookingJson({String status = 'quoted', Map<String, Object?>? extra}) => {
      'id': 'b1',
      'serviceType': 'home_guard',
      'serviceName': 'Home Guard',
      'status': status,
      'windowStart': '2026-11-25T10:00:00.000Z',
      'windowEnd': '2026-11-25T12:00:00.000Z',
      'place': {'lat': 28.57, 'lng': 77.32, 'label': 'Sector 18'},
      'notes': 'Ring the bell twice',
      'quote': {'amountPaise': 49950, 'note': 'Two hours', 'expiresAt': null},
      'history': [
        {'status': 'requested', 'at': '2026-11-21T08:00:00.000Z', 'by': 'user'},
        {'status': 'quoted', 'at': '2026-11-21T08:05:00.000Z', 'by': 'system'},
      ],
      'createdAt': '2026-11-21T08:00:00.000Z',
      ...?extra,
    };

AppState makeState(http.Response Function(http.Request) answer) {
  final api = ApiClient(
    baseUrl: 'http://server',
    client: MockClient((req) async {
      calls.add(req);
      return answer(req);
    }),
  )..token = 't';
  final state = AppState(api: api);
  state.me = Me.fromJson(fixtures.me);
  state.stage = Stage.home;
  return state;
}

Widget host(AppState state, Widget child) => AppScope(state: state, child: MaterialApp(theme: buildTheme(), home: child));

http.Response notThere(http.Request r) => http.Response(jsonEncode({'error': 'not_found', 'message': 'No such route.'}), 404);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    calls.clear();
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(const MethodChannel('sarthi/engine'), (call) async => null);
  });

  test('nearby Rakshaks: asks with position and radius, reads the refresh rule', () async {
    final state = makeState((r) => http.Response(
          jsonEncode({
            'items': [
              {'id': 'r1', 'firstName': 'Asha', 'lat': 28.5, 'lng': 77.3, 'distanceM': 850, 'etaMinutes': 6, 'updatedAt': '2026-11-21T08:00:00.000Z'},
              {'id': 'r2', 'firstName': 'Vikram', 'lat': 28.51, 'lng': 77.31, 'distanceM': 1900},
            ],
            'refreshSeconds': 5, // below the floor: the app never refreshes faster than 10 s
            'maxRadiusM': 3000,
          }),
          200,
        ));
    final reply = await state.api.nearbyRakshaks(28.5, 77.3, 2000);
    expect(calls.single.url.path, '/v1/rakshaks/nearby');
    expect(calls.single.url.queryParameters, {'lat': '28.5', 'lng': '77.3', 'radiusM': '2000'});
    expect(reply.items.length, 2);
    expect(reply.items.first.etaMinutes, 6);
    expect(reply.items.last.etaMinutes, isNull);
    expect(reply.refreshSeconds, 10);
    expect(reply.maxRadiusM, 3000);
  });

  test('a booking is created with an id made on the phone and UTC times', () async {
    final state = makeState((r) => http.Response(jsonEncode(bookingJson(status: 'requested')), 201));
    final b = await state.api.createBooking(
      id: 'uuid-1',
      serviceType: 'home_guard',
      windowStart: DateTime.utc(2026, 11, 25, 10),
      windowEnd: DateTime.utc(2026, 11, 25, 12),
      lat: 28.57,
      lng: 77.32,
      label: 'Sector 18',
      notes: '  Ring twice  ',
    );
    final body = jsonDecode(calls.single.body) as Map<String, dynamic>;
    expect(calls.single.method, 'POST');
    expect(calls.single.url.path, '/v1/bookings');
    expect(body['id'], 'uuid-1');
    expect(body['windowStart'], '2026-11-25T10:00:00.000Z');
    expect(body['place'], {'lat': 28.57, 'lng': 77.32, 'label': 'Sector 18'});
    expect(body['notes'], 'Ring twice');
    expect(b.status, 'requested');
    expect(b.finished, isFalse);
  });

  test('booking replies: quote, history, defaults and finished states', () {
    final b = Booking.fromJson(bookingJson());
    expect(b.quote!.amountPaise, 49950);
    expect(money(b.quote!.amountPaise), '₹499.50');
    expect(money(50000), '₹500');
    expect(b.history.map((h) => h.status), ['requested', 'quoted']);
    expect(b.canCancel, isTrue);
    expect(Booking.fromJson(bookingJson(status: 'completed')).canCancel, isFalse);
    expect(Booking.fromJson(bookingJson(status: 'cancelled')).finished, isTrue);
    // A reply with fewer fields still reads.
    final bare = Booking.fromJson({'id': 'x', 'status': 'requested', 'windowStart': '2026-11-25T10:00:00Z', 'windowEnd': '2026-11-25T11:00:00Z'});
    expect(bare.serviceName, 'Booking');
    expect(bare.history, isEmpty);
    expect(bare.quote, isNull);
  });

  test('accept, decline and cancel go to their own addresses', () async {
    final state = makeState((r) => http.Response(jsonEncode(bookingJson(status: 'confirmed')), 200));
    await state.api.acceptQuote('b1');
    await state.api.declineQuote('b1');
    await state.api.cancelBooking('b1', reason: 'plans changed');
    expect(calls.map((c) => '${c.method} ${c.url.path}'), [
      'POST /v1/bookings/b1/quote/accept',
      'POST /v1/bookings/b1/quote/decline',
      'POST /v1/bookings/b1/cancel',
    ]);
    expect(jsonDecode(calls.last.body), {'reason': 'plans changed'});
  });

  test('a server without the Phase 3 calls reads as "not available yet"', () async {
    final state = makeState(notThere);
    await expectLater(state.api.bookings(), throwsA(predicate(phase3Unavailable)));
    await expectLater(state.api.nearbyRakshaks(1, 2, 1000), throwsA(predicate(phase3Unavailable)));
    // A real error (offline, server busy) is not "not available".
    expect(phase3Unavailable(ApiException(503, 'server_busy', 'busy')), isFalse);
    expect(phase3Unavailable(ApiException(0, 'offline', 'no internet')), isFalse);
    expect(phase3Unavailable(StateError('x')), isFalse);
  });

  test('Phase 3 menu items stay hidden until the server (or a test build) turns them on', () {
    final off = makeState(notThere);
    expect(off.feature3('bookings'), isFalse);
    off.me = Me.fromJson({...fixtures.me, 'rules': {'feature.bookings': 1}});
    expect(off.feature3('bookings'), isTrue);
    expect(off.feature3('nearby'), isFalse);
  });

  testWidgets('My bookings: lists bookings with their status', (tester) async {
    final state = makeState((r) => http.Response(jsonEncode([bookingJson(), bookingJson(status: 'completed', extra: {'id': 'b2', 'serviceName': 'Senior Safety Visit'})]), 200));
    await tester.pumpWidget(host(state, const BookingsScreen()));
    await tester.pumpAndSettle();
    expect(find.text('Home Guard'), findsOneWidget);
    expect(find.text('Senior Safety Visit'), findsOneWidget);
    expect(find.text('Quote ready'), findsOneWidget);
    expect(find.text('Completed'), findsOneWidget);
    expect(find.text('Book a Rakshak'), findsOneWidget);
  });

  testWidgets('My bookings: empty list says so (no made-up bookings)', (tester) async {
    final state = makeState((r) => http.Response('[]', 200));
    await tester.pumpWidget(host(state, const BookingsScreen()));
    await tester.pumpAndSettle();
    expect(find.textContaining('No bookings yet'), findsOneWidget);
  });

  testWidgets('My bookings: server without bookings shows "Not available yet"', (tester) async {
    final state = makeState(notThere);
    await tester.pumpWidget(host(state, const BookingsScreen()));
    await tester.pumpAndSettle();
    expect(find.text('Not available yet'), findsOneWidget);
    expect(find.text('Book a Rakshak'), findsNothing);
  });

  testWidgets('Book a Rakshak: server without services shows "Not available yet"', (tester) async {
    final state = makeState(notThere);
    await tester.pumpWidget(host(state, const BookScreen()));
    await tester.pumpAndSettle();
    expect(find.text('Not available yet'), findsOneWidget);
  });

  testWidgets('Book a Rakshak: needs a service and a place before sending', (tester) async {
    final state = makeState((r) {
      if (r.url.path == '/v1/booking/services') {
        return http.Response(
          jsonEncode([
            {'id': 'home_guard', 'name': 'Home Guard', 'description': 'A Rakshak stays at your home.'},
            {'id': 'senior_visit', 'name': 'Senior Safety Visit', 'description': ''},
          ]),
          200,
        );
      }
      if (r.url.path == '/v1/places') return http.Response('[]', 200);
      return http.Response(jsonEncode(bookingJson(status: 'requested')), 201);
    });
    await tester.pumpWidget(host(state, const BookScreen()));
    await tester.pumpAndSettle();
    expect(find.text('Home Guard'), findsOneWidget);
    await tester.scrollUntilVisible(find.text('Send request'), 300, scrollable: find.byType(Scrollable).first);
    await tester.tap(find.text('Send request'));
    await tester.pumpAndSettle();
    expect(find.text('Choose a service.'), findsOneWidget);
    expect(calls.where((c) => c.method == 'POST'), isEmpty);
    await tester.scrollUntilVisible(find.text('Home Guard'), -300, scrollable: find.byType(Scrollable).first);
    await tester.tap(find.text('Home Guard'));
    await tester.pump();
    await tester.scrollUntilVisible(find.text('Send request'), 300, scrollable: find.byType(Scrollable).first);
    await tester.tap(find.text('Send request'));
    await tester.pumpAndSettle();
    expect(find.text('Choose where you need the Rakshak.'), findsOneWidget);
    expect(calls.where((c) => c.method == 'POST'), isEmpty);
  });

  testWidgets('Booking detail: accepting a quote, and cancelling asks first', (tester) async {
    final state = makeState((r) {
      if (r.url.path.endsWith('/quote/accept')) return http.Response(jsonEncode(bookingJson(status: 'confirmed', extra: {'quote': null, 'cancelMessage': 'A fee may apply.'})), 200);
      if (r.url.path.endsWith('/cancel')) return http.Response(jsonEncode(bookingJson(status: 'cancelled', extra: {'quote': null, 'canCancel': false})), 200);
      return http.Response(jsonEncode(bookingJson()), 200);
    });
    await tester.pumpWidget(host(state, BookingDetailScreen(booking: Booking.fromJson(bookingJson(extra: {'cancelMessage': 'A fee may apply.'})))));
    await tester.pump();
    expect(find.text('₹499.50'), findsOneWidget);
    await tester.tap(find.text('Accept quote'));
    await tester.pumpAndSettle();
    expect(calls.any((c) => c.url.path == '/v1/bookings/b1/quote/accept'), isTrue);
    expect(find.text('Quote'), findsNothing);
    await tester.scrollUntilVisible(find.text('Cancel booking'), 300, scrollable: find.byType(Scrollable).first);
    await tester.tap(find.text('Cancel booking'));
    await tester.pumpAndSettle();
    expect(find.text('A fee may apply.'), findsOneWidget);
    expect(calls.any((c) => c.url.path.endsWith('/cancel')), isFalse); // not until the user confirms
    await tester.tap(find.text('Cancel booking').last);
    await tester.pumpAndSettle();
    expect(calls.any((c) => c.url.path == '/v1/bookings/b1/cancel'), isTrue);
    expect(find.text('Cancelled'), findsWidgets);
  });
}
