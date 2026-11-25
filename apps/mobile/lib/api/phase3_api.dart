import 'api_client.dart';

// Phase 3 customer calls and models: Rakshaks near me, bookings.
// The server side is not built yet. The contract these calls expect is written in
// docs/app-api-phase3.md. Until the server has them, the screens show "not available yet".

Map<String, dynamic> _obj(Object? v) => v as Map<String, dynamic>;
List<dynamic> _list(Object? v) => (v as List<dynamic>?) ?? const [];
DateTime? _date(Object? v) => v == null ? null : DateTime.parse(v as String).toLocal();

/// The server does not have this Phase 3 call yet (an older server): show "not available yet",
/// never an error and never made-up data.
bool phase3Unavailable(Object error) => error is ApiException && (error.status == 404 || error.status == 501);

/// A verified, online Rakshak near the user. Only a first name and an approximate position.
class NearbyRakshak {
  NearbyRakshak({
    required this.id,
    required this.firstName,
    required this.lat,
    required this.lng,
    required this.distanceM,
    this.etaMinutes,
    this.updatedAt,
  });

  final String id;
  final String firstName;
  final double lat;
  final double lng;
  final int distanceM;

  /// Travel time by road for the nearest few only (null for the others).
  final int? etaMinutes;
  final DateTime? updatedAt;

  factory NearbyRakshak.fromJson(Map<String, dynamic> j) => NearbyRakshak(
        id: j['id'] as String,
        firstName: (j['firstName'] as String?) ?? 'Rakshak',
        lat: (j['lat'] as num).toDouble(),
        lng: (j['lng'] as num).toDouble(),
        distanceM: (j['distanceM'] as num?)?.round() ?? 0,
        etaMinutes: (j['etaMinutes'] as num?)?.round(),
        updatedAt: _date(j['updatedAt']),
      );
}

class NearbyReply {
  NearbyReply(this.items, {this.refreshSeconds = 30, this.maxRadiusM = 5000});
  final List<NearbyRakshak> items;

  /// How often the server wants the screen to refresh (it controls the cost).
  final int refreshSeconds;
  final int maxRadiusM;

  factory NearbyReply.fromJson(Map<String, dynamic> j) => NearbyReply(
        _list(j['items']).map((i) => NearbyRakshak.fromJson(_obj(i))).toList(),
        refreshSeconds: ((j['refreshSeconds'] as num?)?.round() ?? 30).clamp(10, 300),
        maxRadiusM: (j['maxRadiusM'] as num?)?.round() ?? 5000,
      );
}

/// A kind of booking (Pre-booking, Invisible Rakshak, Home Guard, Senior Safety Visit).
/// The list comes from the server: the service type is a setting, not hard-coded.
class ServiceType {
  ServiceType({required this.id, required this.name, required this.description});
  final String id;
  final String name;
  final String description;

  factory ServiceType.fromJson(Map<String, dynamic> j) => ServiceType(
        id: j['id'] as String,
        name: j['name'] as String,
        description: (j['description'] as String?) ?? '',
      );
}

class BookingQuote {
  BookingQuote({required this.amountPaise, this.note, this.expiresAt});
  final int amountPaise;
  final String? note;
  final DateTime? expiresAt;

  factory BookingQuote.fromJson(Map<String, dynamic> j) => BookingQuote(
        amountPaise: (j['amountPaise'] as num).round(),
        note: j['note'] as String?,
        expiresAt: _date(j['expiresAt']),
      );
}

class BookingRakshak {
  BookingRakshak({required this.firstName, this.etaMinutes});
  final String firstName;
  final int? etaMinutes;

  factory BookingRakshak.fromJson(Map<String, dynamic> j) => BookingRakshak(
        firstName: (j['firstName'] as String?) ?? 'Rakshak',
        etaMinutes: (j['etaMinutes'] as num?)?.round(),
      );
}

/// searching, offered or no_match, plus a message from the server for the user.
class BookingMatching {
  BookingMatching({required this.state, this.message});
  final String state;
  final String? message;

  factory BookingMatching.fromJson(Map<String, dynamic> j) =>
      BookingMatching(state: (j['state'] as String?) ?? 'searching', message: j['message'] as String?);
}

class BookingStep {
  BookingStep({required this.status, required this.at, this.by});
  final String status;
  final DateTime at;

  /// user, rakshak, admin or system.
  final String? by;

  factory BookingStep.fromJson(Map<String, dynamic> j) => BookingStep(
        status: j['status'] as String,
        at: _date(j['at']) ?? DateTime.now(),
        by: j['by'] as String?,
      );
}

/// requested, quoted, confirmed, assigned, in_progress, completed or cancelled.
class Booking {
  Booking({
    required this.id,
    required this.serviceType,
    required this.serviceName,
    required this.status,
    required this.windowStart,
    required this.windowEnd,
    required this.placeLabel,
    this.lat,
    this.lng,
    this.notes,
    this.quote,
    this.rakshak,
    this.matching,
    this.canCancel = true,
    this.cancelMessage,
    this.history = const [],
    required this.createdAt,
  });

  final String id;
  final String serviceType;
  final String serviceName;
  final String status;
  final DateTime windowStart;
  final DateTime windowEnd;
  final String placeLabel;
  final double? lat;
  final double? lng;
  final String? notes;
  final BookingQuote? quote;
  final BookingRakshak? rakshak;
  final BookingMatching? matching;

  /// The server decides (cancellation rules); false once the booking is completed or cancelled.
  final bool canCancel;

  /// What the server says about cancelling (for example any charge), shown before the user confirms.
  final String? cancelMessage;
  final List<BookingStep> history;
  final DateTime createdAt;

  bool get finished => status == 'completed' || status == 'cancelled';

  factory Booking.fromJson(Map<String, dynamic> j) {
    final place = j['place'] is Map<String, dynamic> ? j['place'] as Map<String, dynamic> : const <String, dynamic>{};
    final status = j['status'] as String;
    return Booking(
      id: j['id'] as String,
      serviceType: (j['serviceType'] as String?) ?? '',
      serviceName: (j['serviceName'] as String?) ?? (j['serviceType'] as String?) ?? 'Booking',
      status: status,
      windowStart: _date(j['windowStart']) ?? DateTime.now(),
      windowEnd: _date(j['windowEnd']) ?? DateTime.now(),
      placeLabel: (place['label'] as String?) ?? (place['address'] as String?) ?? '',
      lat: (place['lat'] as num?)?.toDouble(),
      lng: (place['lng'] as num?)?.toDouble(),
      notes: j['notes'] as String?,
      quote: j['quote'] is Map<String, dynamic> ? BookingQuote.fromJson(j['quote'] as Map<String, dynamic>) : null,
      rakshak: j['rakshak'] is Map<String, dynamic> ? BookingRakshak.fromJson(j['rakshak'] as Map<String, dynamic>) : null,
      matching: j['matching'] is Map<String, dynamic> ? BookingMatching.fromJson(j['matching'] as Map<String, dynamic>) : null,
      canCancel: (j['canCancel'] as bool?) ?? (status != 'completed' && status != 'cancelled'),
      cancelMessage: j['cancelMessage'] as String?,
      history: _list(j['history']).map((h) => BookingStep.fromJson(_obj(h))).toList(),
      createdAt: _date(j['createdAt']) ?? DateTime.now(),
    );
  }
}

extension Phase3Api on ApiClient {
  // ---- Rakshaks near me -------------------------------------------------------------------------

  Future<NearbyReply> nearbyRakshaks(double lat, double lng, int radiusM) async => NearbyReply.fromJson(_obj(await send(
        'GET',
        '/v1/rakshaks/nearby',
        query: {'lat': '$lat', 'lng': '$lng', 'radiusM': '$radiusM'},
      )));

  // ---- Bookings ---------------------------------------------------------------------------------

  Future<List<ServiceType>> bookingServices() async =>
      _list(await send('GET', '/v1/booking/services')).map((s) => ServiceType.fromJson(_obj(s))).toList();

  /// [id] is made on the phone, so a repeated send never creates two bookings.
  Future<Booking> createBooking({
    required String id,
    required String serviceType,
    required DateTime windowStart,
    required DateTime windowEnd,
    required double lat,
    required double lng,
    required String label,
    String? notes,
  }) async =>
      Booking.fromJson(_obj(await send('POST', '/v1/bookings', body: {
        'id': id,
        'serviceType': serviceType,
        'windowStart': windowStart.toUtc().toIso8601String(),
        'windowEnd': windowEnd.toUtc().toIso8601String(),
        'place': {'lat': lat, 'lng': lng, 'label': label},
        if (notes != null && notes.trim().isNotEmpty) 'notes': notes.trim(),
      })));

  Future<List<Booking>> bookings() async =>
      _list(await send('GET', '/v1/bookings')).map((b) => Booking.fromJson(_obj(b))).toList();

  Future<Booking> booking(String id) async => Booking.fromJson(_obj(await send('GET', '/v1/bookings/$id')));

  Future<Booking> acceptQuote(String id) async => Booking.fromJson(_obj(await send('POST', '/v1/bookings/$id/quote/accept')));

  Future<Booking> declineQuote(String id) async => Booking.fromJson(_obj(await send('POST', '/v1/bookings/$id/quote/decline')));

  Future<Booking> cancelBooking(String id, {String? reason}) async => Booking.fromJson(_obj(await send(
        'POST',
        '/v1/bookings/$id/cancel',
        body: {if (reason != null && reason.isNotEmpty) 'reason': reason},
      )));
}
