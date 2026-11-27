import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:sarthi_rakshak/api/api_client.dart';
import 'package:sarthi_rakshak/api/models.dart';
import 'package:sarthi_rakshak/api/phase3_api.dart';
import 'package:sarthi_rakshak/screens/community/rakshak_screen.dart';
import 'package:sarthi_rakshak/screens/phase3/book_screen.dart';
import 'package:sarthi_rakshak/screens/phase3/bookings_screen.dart';
import 'package:sarthi_rakshak/screens/phase3/phase3_common.dart';
import 'package:sarthi_rakshak/screens/phase4/child_screens.dart';
import 'package:sarthi_rakshak/screens/phase4/support_screens.dart';
import 'package:sarthi_rakshak/screens/phase4/tools_screen.dart';
import 'package:sarthi_rakshak/state/app_state.dart';
import 'package:sarthi_rakshak/theme.dart';
import 'package:shared_preferences/shared_preferences.dart';

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

  testWidgets('An approved Rakshak switches "Available now" on after agreeing; it runs for the set hours', (tester) async {
    SharedPreferences.setMockInitialValues({});
    final engine = <MethodCall>[];
    var until = 0;
    final m = TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    m.setMockMethodCallHandler(const MethodChannel('sarthi/engine'), (call) async {
      engine.add(call);
      switch (call.method) {
        case 'rakshakAvailableStart':
          until = DateTime.now().add(Duration(hours: (call.arguments as Map)['hours'] as int)).millisecondsSinceEpoch;
        case 'rakshakAvailableStop':
          until = 0;
        case 'rakshakAvailableUntil':
          return until;
      }
      return null;
    });
    for (final name in ['flutter.baseflow.com/geolocator_android', 'flutter.baseflow.com/geolocator']) {
      m.setMockMethodCallHandler(MethodChannel(name), (call) async => switch (call.method) {
            'checkPermission' => 2, // while in use
            _ => null,
          });
    }
    final state = makeState((r) => http.Response(
          jsonEncode({
            'application': {
              'id': 'a1',
              'status': 'approved',
              'reason': null,
              'area': 'Sector 18',
              'areas': ['Sector 18'],
              'createdAt': '2026-11-20T10:00:00Z',
              'decidedAt': '2026-11-21T10:00:00Z',
            },
          }),
          200,
        ));
    state.me = Me.fromJson({
      ...fixtures.me,
      'rules': <String, dynamic>{...(fixtures.me['rules'] as Map<String, dynamic>), 'feature.nearby': 1, 'rakshak.available_hours': 4},
    });
    await tester.binding.setSurfaceSize(const Size(420, 1600));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(host(state, const RakshakScreen()));
    await tester.pumpAndSettle();

    final sw = find.byKey(const Key('rakshak-available'));
    expect(tester.widget<SwitchListTile>(sw).value, isFalse);
    await tester.tap(sw);
    await tester.pumpAndSettle();
    expect(find.textContaining('Only your first name is shown'), findsOneWidget); // consent first
    await tester.tap(find.text('I agree'));
    await tester.pumpAndSettle();
    expect(engine.singleWhere((c) => c.method == 'rakshakAvailableStart').arguments, {'hours': 4});
    expect(tester.widget<SwitchListTile>(sw).value, isTrue);
    expect(find.textContaining('On until'), findsOneWidget);

    await tester.tap(sw); // off
    await tester.pumpAndSettle();
    expect(engine.any((c) => c.method == 'rakshakAvailableStop'), isTrue);
    expect(tester.widget<SwitchListTile>(sw).value, isFalse);
  });

  testWidgets('Night Mode switch moves at once, even before the server answers', (tester) async {
    final never = Completer<http.Response>();
    final api = ApiClient(
      baseUrl: 'http://server',
      client: MockClient((req) {
        calls.add(req);
        // The saved state never arrives (a slow link); saving answers.
        if (req.method == 'GET') return never.future;
        return Future.value(http.Response(jsonEncode({'active': true}), 200));
      }),
    )..token = 't';
    final state = AppState(api: api)
      ..me = Me.fromJson(fixtures.me)
      ..stage = Stage.home;
    await tester.pumpWidget(host(state, const ToolsScreen()));
    await tester.pump();
    final sw = find.byType(SwitchListTile).first;
    expect(tester.widget<SwitchListTile>(sw).onChanged, isNotNull); // never greyed out
    await tester.tap(sw);
    await tester.pump();
    expect(tester.widget<SwitchListTile>(sw).value, isTrue);
    expect(calls.where((c) => c.method == 'PUT' && c.url.path == '/v1/night-mode'), hasLength(1));
    expect(find.text('SOS'), findsOneWidget); // one label, not "SOS SOS"
    expect(find.byIcon(Icons.sos), findsNothing);

    // The old state arrives late: the user's tap still wins.
    never.complete(http.Response(jsonEncode({'active': false}), 200));
    await tester.pump(const Duration(minutes: 1));
    expect(tester.widget<SwitchListTile>(sw).value, isTrue);
  });

  testWidgets("Men's Safety: one \"My reports\" list for both types; New report asks which type", (tester) async {
    await tester.binding.setSurfaceSize(const Size(420, 1600));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final state = makeState((r) {
      if (r.url.path == '/v1/incident-reports') {
        return http.Response(
          jsonEncode({
            'items': [
              {'id': 'r1', 'kind': 'workplace', 'category': 'harassment', 'status': 'submitted', 'reference': 'SR-AAAA1111'},
              {'id': 'r2', 'kind': 'false_accusation', 'category': 'allegation', 'status': 'draft', 'reference': null},
            ],
          }),
          200,
        );
      }
      return notThere(r);
    });
    await tester.pumpWidget(host(state, const LegalSupportScreen()));
    await tester.pumpAndSettle();
    // One row for reports (it used to be two rows opening the same list).
    expect(find.byKey(const Key('men-reports')), findsOneWidget);
    expect(find.text('Workplace report'), findsNothing);
    expect(find.text('Lawyer requests'), findsOneWidget);

    await tester.tap(find.byKey(const Key('men-reports')));
    await tester.pumpAndSettle();
    expect(find.text('My reports'), findsOneWidget);
    expect(find.text('Workplace report'), findsOneWidget); // each report says its type
    expect(find.text('A disputed allegation'), findsOneWidget);

    await tester.tap(find.byKey(const Key('new-report')));
    await tester.pumpAndSettle();
    expect(find.text('What kind of report?'), findsOneWidget);
    expect(find.byKey(const Key('new-report-workplace')), findsOneWidget);
    expect(find.byKey(const Key('new-report-false_accusation')), findsOneWidget);
  });

  testWidgets('Women Safety: "My reports" makes a harassment report straight away (one type)', (tester) async {
    await tester.binding.setSurfaceSize(const Size(420, 1600));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final state = makeState((r) =>
        r.url.path == '/v1/incident-reports' ? http.Response(jsonEncode({'items': []}), 200) : notThere(r));
    await tester.pumpWidget(host(state, const IncidentListScreen(group: 'women', kinds: ['harassment'])));
    await tester.pumpAndSettle();
    expect(find.text('No reports yet.'), findsOneWidget);
    await tester.tap(find.byKey(const Key('new-report')));
    await tester.pumpAndSettle();
    expect(find.text('What kind of report?'), findsNothing); // only one type: no question
    expect(find.byType(IncidentFormScreen), findsOneWidget);
  });

  testWidgets('Child mode: a link request shows with Accept and Decline (the screen used to stay blank)', (tester) async {
    await tester.binding.setSurfaceSize(const Size(420, 900));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final state = makeState((r) {
      if (r.url.path == '/v1/child/invitations') {
        return http.Response(
          jsonEncode({
            'invitations': [
              {'id': 'i1', 'parentName': 'Anjali', 'createdAt': '2026-11-27T10:27:05.504Z'},
            ],
            'linkedParents': [],
            'sharing': false,
          }),
          200,
        );
      }
      if (r.url.path == '/v1/child/invitations/i1/accept') return http.Response('', 204);
      return notThere(r);
    });
    await tester.pumpWidget(host(state, const ChildModeScreen()));
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull); // no layout failure
    expect(find.text('Anjali wants to see where you are.'), findsOneWidget);
    expect(find.byKey(const Key('decline-i1')), findsOneWidget);
    await tester.tap(find.byKey(const Key('accept-i1')));
    await tester.pumpAndSettle();
    expect(calls.any((c) => c.method == 'POST' && c.url.path == '/v1/child/invitations/i1/accept'), isTrue);
  });

  testWidgets('A sent booking says "Request sent" instead of a spinner that never stops', (tester) async {
    final state = makeState((r) => http.Response(jsonEncode(bookingJson(status: 'requested')), 200));
    final b = Booking.fromJson(bookingJson(status: 'requested', extra: {
      'quote': null,
      'matching': {'state': 'searching', 'message': 'Finding a Rakshak near you…'},
    }));
    await tester.pumpWidget(host(state, BookingDetailScreen(booking: b)));
    await tester.pumpAndSettle(); // settles: nothing keeps spinning
    expect(find.byKey(const Key('booking-sent')), findsOneWidget);
    expect(find.text('Request sent'), findsOneWidget);
    expect(find.byType(CircularProgressIndicator), findsNothing);
  });

  testWidgets('Book a Rakshak: "Search a place" finds any place and books there', (tester) async {
    await tester.binding.setSurfaceSize(const Size(420, 2600));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(const MethodChannel('sarthi/engine'), (call) async => switch (call.method) {
              'geocodeSearch' => [
                  {'name': 'Siya Girls PG', 'address': 'Sector 49, Noida, Uttar Pradesh', 'lat': 28.56, 'lng': 77.36},
                ],
              _ => null,
            });
    final state = makeState((r) {
      if (r.url.path == '/v1/booking/services') {
        return http.Response(
          jsonEncode([
            {'id': 'home_guard', 'name': 'Home Guard', 'description': 'A Rakshak stays at your home.'},
          ]),
          200,
        );
      }
      if (r.url.path == '/v1/places') return http.Response('[]', 200);
      return http.Response(jsonEncode(bookingJson(status: 'requested')), 201);
    });
    await tester.pumpWidget(host(state, const BookScreen()));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Home Guard'));
    await tester.pump();

    await tester.tap(find.byKey(const Key('book-search-place')));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const Key('place-search-sheet')), 'siya girls');
    await tester.pump(const Duration(milliseconds: 600));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Siya Girls PG'));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('book-place-selected')), findsOneWidget);

    await tester.tap(find.text('Send request'));
    await tester.pumpAndSettle();
    final post = calls.lastWhere((c) => c.method == 'POST' && c.url.path == '/v1/bookings');
    final body = jsonDecode(post.body) as Map<String, Object?>;
    expect(jsonEncode(body), contains('Sector 49, Noida, Uttar Pradesh'));
    expect(jsonEncode(body), contains('28.56'));
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
