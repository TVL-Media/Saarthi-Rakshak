import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:sarthi_rakshak/api/api_client.dart';
import 'package:sarthi_rakshak/api/models.dart';

const me = {
  'id': '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b',
  'name': 'Priya Sharma',
  'phone': '+919812344521',
  'bloodGroup': 'B+',
  'photoUrl': null,
  'consentGiven': true,
  'guardiansCount': 2,
  'acceptedGuardiansCount': 1,
  'rules': {'sos.countdown_seconds': 5, 'checkin.reply_wait_minutes': 2},
};

void main() {
  test('a file upload with no connection says so (it used to fail with no message)', () async {
    final tmp = await Directory.systemTemp.createTemp('upload');
    addTearDown(() => tmp.delete(recursive: true));
    final file = File('${tmp.path}/id.jpg')..writeAsBytesSync(List.filled(10, 1));
    final api = ApiClient(
      baseUrl: 'http://server/',
      client: MockClient.streaming((req, body) async {
        await body.drain<void>();
        throw http.ClientException('Connection refused');
      }),
    );
    await expectLater(
      api.uploadFile(UploadLink('k', 'http://storage/put', const {}), file.path),
      throwsA(isA<ApiException>().having((e) => e.message, 'message', 'No internet connection. Please try again.')),
    );
  });

  test('login sends the Firebase token and reads our session', () async {
    late http.Request sent;
    final api = ApiClient(
      baseUrl: 'http://server/',
      client: MockClient((req) async {
        sent = req;
        return http.Response(jsonEncode({'token': 'abc', 'user': me, 'isNewUser': true}), 200);
      }),
    );
    final (token, user, isNew) = await api.login('firebase-token');
    expect(sent.url.toString(), 'http://server/v1/auth/firebase');
    expect(jsonDecode(sent.body), {'firebaseIdToken': 'firebase-token'});
    expect(token, 'abc');
    expect(user.firstName, 'Priya');
    expect(user.rule('sos.countdown_seconds', 9), 5);
    expect(isNew, isTrue);
  });

  test('sends the bearer token and turns errors into ApiException', () async {
    String? auth;
    final api = ApiClient(
      baseUrl: 'http://server',
      client: MockClient((req) async {
        auth = req.headers['Authorization'];
        return http.Response(jsonEncode({'error': 'limit_reached', 'message': 'You can have up to 5 guardians.'}), 409);
      }),
    )..token = 't1';
    await expectLater(
      api.addGuardian('Ravi', '+919800000001', null),
      throwsA(isA<ApiException>()
          .having((e) => e.code, 'code', 'limit_reached')
          .having((e) => e.message, 'message', 'You can have up to 5 guardians.')),
    );
    expect(auth, 'Bearer t1');
  });

  test('a 401 ends the session', () async {
    var ended = false;
    final api = ApiClient(
      baseUrl: 'http://server',
      client: MockClient((_) async => http.Response(jsonEncode({'error': 'not_logged_in', 'message': 'Please log in again.'}), 401)),
    )
      ..token = 't'
      ..onSessionEnded = () => ended = true;
    await expectLater(api.me(), throwsA(isA<ApiException>()));
    expect(ended, isTrue);
  });

  test('no connection is reported as offline', () async {
    final api = ApiClient(baseUrl: 'http://server', client: MockClient((_) async => throw http.ClientException('down')));
    await expectLater(api.me(), throwsA(isA<ApiException>().having((e) => e.isOffline, 'offline', true)));
  });

  test('active SOS: 204 means none', () async {
    final api = ApiClient(baseUrl: 'http://server', client: MockClient((_) async => http.Response('', 204)));
    expect(await api.activeSos(), isNull);
  });

  test('history passes the type and cursor', () async {
    late Uri url;
    final api = ApiClient(
      baseUrl: 'http://server',
      client: MockClient((req) async {
        url = req.url;
        return http.Response(jsonEncode({'items': [], 'nextCursor': null}), 200);
      }),
    );
    final page = await api.history(type: 'sos', cursor: 'c1');
    expect(url.queryParameters, {'type': 'sos', 'cursor': 'c1'});
    expect(page.items, isEmpty);
    expect(page.nextCursor, isNull);
  });

  test('delete account sends the fresh token and DELETE', () async {
    late http.Request sent;
    final api = ApiClient(
      baseUrl: 'http://server',
      client: MockClient((req) async {
        sent = req;
        return http.Response('', 204);
      }),
    );
    await api.deleteAccount('fresh');
    expect(sent.method, 'DELETE');
    expect(jsonDecode(sent.body), {'firebaseIdToken': 'fresh', 'confirm': 'DELETE'});
  });
}
