import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:http/http.dart' as http;

import '../config.dart';
import 'models.dart';

/// A failed call: the server's `{ error, message }`, or `offline` / `server_error` from the app.
class ApiException implements Exception {
  ApiException(this.status, this.code, this.message);
  final int status;
  final String code;
  final String message;

  bool get isOffline => code == 'offline';
  bool get notLoggedIn => code == 'not_logged_in';

  @override
  String toString() => 'ApiException($status $code: $message)';
}

/// All calls to the server (`/v1/...`), as listed in docs/app-api.md.
class ApiClient {
  ApiClient({http.Client? client, String? baseUrl})
      : _http = client ?? http.Client(),
        baseUrl = (baseUrl ?? AppConfig.apiUrl).replaceAll(RegExp(r'/+$'), '');

  final http.Client _http;
  final String baseUrl;

  /// Our session token (set after login).
  String? token;

  /// Called when the server says the session has ended (logout elsewhere, new phone, deleted).
  void Function()? onSessionEnded;

  /// Long enough for a test server that was asleep to wake up (about a minute on Render's free plan).
  static const _timeout = Duration(seconds: 70);

  Future<dynamic> _call(String method, String path, {Object? body, Map<String, String>? query}) async {
    final uri = Uri.parse('$baseUrl$path').replace(queryParameters: query);
    final headers = <String, String>{
      'Accept': 'application/json',
      if (body != null) 'Content-Type': 'application/json',
      if (token != null) 'Authorization': 'Bearer $token',
    };
    http.Response res;
    try {
      final req = http.Request(method, uri)..headers.addAll(headers);
      if (body != null) req.body = jsonEncode(body);
      res = await http.Response.fromStream(await _http.send(req).timeout(_timeout));
    } on SocketException {
      throw ApiException(0, 'offline', 'No internet connection. Please try again.');
    } on TimeoutException {
      throw ApiException(0, 'offline', 'The server is not answering. Check your internet and try again.');
    } on http.ClientException {
      throw ApiException(0, 'offline', 'No internet connection. Please try again.');
    }

    if (res.statusCode == 204) return null;
    dynamic json;
    try {
      json = res.body.isEmpty ? null : jsonDecode(utf8.decode(res.bodyBytes));
    } on FormatException {
      json = null;
    }
    if (res.statusCode >= 200 && res.statusCode < 300) return json;

    final map = json is Map<String, dynamic> ? json : const <String, dynamic>{};
    final err = map['error'] is String
        ? ApiException(
            res.statusCode,
            map['error'] as String,
            res.statusCode >= 500
                // The server's own "something went wrong": add the number so it can be found in its log.
                ? '${(map['message'] as String?) ?? 'Something went wrong on the server.'} (error ${res.statusCode})'
                : (map['message'] as String?) ?? 'Please try again. (error ${res.statusCode})',
          )
        : _noServerReply(res.statusCode);
    if (err.notLoggedIn && token != null) onSessionEnded?.call();
    throw err;
  }

  /// A reply that did not come from our server (no `{ error, message }`), e.g. from the hosting
  /// while the server is starting, restarting or busy.
  ApiException _noServerReply(int status) => switch (status) {
        502 || 503 || 504 => ApiException(
            status, 'server_busy', 'The server is starting or busy. Please try again in a minute.'),
        404 => ApiException(status, 'not_found', 'The server does not know this request. Update the app. (error 404)'),
        _ => ApiException(status, 'server_error', 'Something went wrong on the server. Please try again. (error $status)'),
      };

  Map<String, dynamic> _obj(dynamic v) => v as Map<String, dynamic>;

  // ---- A1 login -------------------------------------------------------------------------------

  /// Returns (token, me, isNewUser).
  Future<(String, Me, bool)> login(String firebaseIdToken) async {
    final j = _obj(await _call('POST', '/v1/auth/firebase', body: {'firebaseIdToken': firebaseIdToken}));
    return (j['token'] as String, Me.fromJson(_obj(j['user'])), j['isNewUser'] as bool);
  }

  /// Development only: the server's test number and code (no Firebase).
  Future<(String, Me, bool)> devLogin(String phone, String code) async {
    final j = _obj(await _call('POST', '/v1/auth/dev-login', body: {'phone': phone, 'code': code}));
    return (j['token'] as String, Me.fromJson(_obj(j['user'])), j['isNewUser'] as bool);
  }

  Future<void> logout() => _call('POST', '/v1/auth/logout');

  Future<Me> me() async => Me.fromJson(_obj(await _call('GET', '/v1/me')));

  Future<Me> giveConsent() async =>
      Me.fromJson(_obj(await _call('POST', '/v1/me/consent', body: {'version': AppConfig.consentVersion})));

  // ---- A2 profile and phone -------------------------------------------------------------------

  Future<Me> updateProfile({String? name, String? bloodGroup, bool clearBloodGroup = false}) async =>
      Me.fromJson(_obj(await _call('PATCH', '/v1/me', body: {
        'name': ?name,
        if (bloodGroup != null || clearBloodGroup) 'bloodGroup': bloodGroup,
      })));

  Future<UploadLink> photoUploadLink(int sizeBytes) async =>
      UploadLink.fromJson(_obj(await _call('POST', '/v1/me/photo-upload', body: {'sizeBytes': sizeBytes})));

  Future<Me> savePhoto(String key) async =>
      Me.fromJson(_obj(await _call('POST', '/v1/me/photo', body: {'key': key})));

  /// PUTs a file to an upload link (straight to storage, not through the server).
  Future<void> upload(UploadLink link, List<int> bytes) async {
    final res = await _http
        .put(Uri.parse(link.uploadUrl), headers: link.headers, body: bytes)
        .timeout(const Duration(seconds: 60));
    if (res.statusCode >= 300) throw ApiException(res.statusCode, 'upload_failed', 'Upload failed. Please try again.');
  }

  Future<void> saveDevice(Map<String, dynamic> device) => _call('PUT', '/v1/me/device', body: device);

  // ---- A3 guardians ---------------------------------------------------------------------------

  Future<List<Guardian>> guardians() async =>
      (await _call('GET', '/v1/guardians') as List).map((g) => Guardian.fromJson(_obj(g))).toList();

  Future<Guardian> addGuardian(String name, String phone, String? relation) async =>
      Guardian.fromJson(_obj(await _call('POST', '/v1/guardians', body: {
        'name': name,
        'phone': phone,
        if (relation != null && relation.isNotEmpty) 'relation': relation,
      })));

  Future<Guardian> updateGuardian(String id, {String? name, String? relation}) async =>
      Guardian.fromJson(_obj(await _call('PATCH', '/v1/guardians/$id', body: {
        'name': ?name,
        if (relation != null) 'relation': relation.isEmpty ? null : relation,
      })));

  Future<void> resendInvite(String id) => _call('POST', '/v1/guardians/$id/resend-invite');

  Future<void> removeGuardian(String id) => _call('DELETE', '/v1/guardians/$id');

  // ---- A4 SOS ---------------------------------------------------------------------------------

  Future<Sos> sos(String id) async => Sos.fromJson(_obj(await _call('GET', '/v1/sos/$id')));

  Future<Sos?> activeSos() async {
    final j = await _call('GET', '/v1/sos/active');
    return j == null ? null : Sos.fromJson(_obj(j));
  }

  Future<Sos> endSos(String id) async =>
      Sos.fromJson(_obj(await _call('POST', '/v1/sos/$id/end', body: {'reason': 'safe'})));

  Future<Sos> testSos(String id) async => Sos.fromJson(_obj(await _call('POST', '/v1/sos/test', body: {
        'id': id,
        'startedAt': DateTime.now().toUtc().toIso8601String(),
      })));

  Future<void> reportCancelledSos(String id, String trigger, DateTime startedAt) =>
      _call('POST', '/v1/sos/cancelled', body: {
        'id': id,
        'trigger': trigger,
        'startedAt': startedAt.toUtc().toIso8601String(),
        'cancelledAt': DateTime.now().toUtc().toIso8601String(),
      });

  // ---- A6 journeys ----------------------------------------------------------------------------

  Future<Journey> startJourney(String id, Place destination, DateTime arriveBy, String? route) async =>
      Journey.fromJson(_obj(await _call('POST', '/v1/journeys', body: {
        'id': id,
        'destination': {'lat': destination.lat, 'lng': destination.lng, 'label': destination.label},
        'expectedArrivalAt': arriveBy.toUtc().toIso8601String(),
        'route': ?route,
      })));

  Future<Journey?> activeJourney() async {
    final j = await _call('GET', '/v1/journeys/active');
    return j == null ? null : Journey.fromJson(_obj(j));
  }

  Future<Journey> journey(String id) async => Journey.fromJson(_obj(await _call('GET', '/v1/journeys/$id')));

  Future<Journey> endJourney(String id, {required bool arrived}) async => Journey.fromJson(
      _obj(await _call('POST', '/v1/journeys/$id/end', body: {'outcome': arrived ? 'arrived' : 'ended'})));

  Future<Checkin> answerCheckin(String id, String answer) async =>
      Checkin.fromJson(_obj(await _call('POST', '/v1/checkins/$id/answer', body: {'answer': answer})));

  // ---- A7 history, places, support, delete ----------------------------------------------------

  Future<HistoryPage> history({String? type, String? cursor}) async {
    final j = _obj(await _call('GET', '/v1/history', query: {
      'type': ?type,
      'cursor': ?cursor,
    }));
    return HistoryPage(
      (j['items'] as List).map((i) => HistoryItem.fromJson(_obj(i))).toList(),
      j['nextCursor'] as String?,
    );
  }

  Future<HistoryDetail> historyDetail(String type, String id) async => HistoryDetail.fromJson(
      _obj(await _call('GET', '/v1/history/${type == 'sos' ? 'sos' : 'journeys'}/$id')));

  Future<List<SavedPlace>> places() async =>
      (await _call('GET', '/v1/places') as List).map((p) => SavedPlace.fromJson(_obj(p))).toList();

  Future<SavedPlace> savePlace(String label, String name, double lat, double lng, {String? address}) async =>
      SavedPlace.fromJson(_obj(await _call('POST', '/v1/places', body: {
        'label': label,
        'name': name,
        'lat': lat,
        'lng': lng,
        if (address != null && address.isNotEmpty) 'address': address,
      })));

  Future<void> removePlace(String id) => _call('DELETE', '/v1/places/$id');

  Future<void> reportProblem(String category, String message, {String? appVersion, String? deviceModel}) =>
      _call('POST', '/v1/support-tickets', body: {
        'category': category,
        'message': message,
        'appVersion': ?appVersion,
        'deviceModel': ?deviceModel,
      });

  Future<void> deleteAccount(String freshFirebaseIdToken) => _call('DELETE', '/v1/me', body: {
        'firebaseIdToken': freshFirebaseIdToken,
        'confirm': 'DELETE',
      });

  // ---- A8 audio -------------------------------------------------------------------------------

  Future<AudioClip> keepClip(String id, bool keep) async =>
      AudioClip.fromJson(_obj(await _call('PATCH', '/v1/audio/$id', body: {'keep': keep})));

  Future<String> clipPlayUrl(String id) async => _obj(await _call('GET', '/v1/audio/$id/play'))['url'] as String;

  /// Downloads an encrypted clip (to decrypt on this phone).
  Future<List<int>> download(String url) async {
    final res = await _http.get(Uri.parse(url)).timeout(const Duration(seconds: 60));
    if (res.statusCode != 200) throw ApiException(res.statusCode, 'download_failed', 'Could not load the recording.');
    return res.bodyBytes;
  }
}
