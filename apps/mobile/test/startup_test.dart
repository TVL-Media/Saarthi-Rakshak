import 'dart:convert';

import 'package:flutter/services.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:sarthi_rakshak/api/api_client.dart';
import 'package:sarthi_rakshak/state/app_state.dart';

import 'api_client_test.dart' as fixtures;

/// A secure storage that behaves like a phone with a damaged Keystore key.
class _Storage implements FlutterSecureStorage {
  _Storage({this.token, this.readFails = false});
  final String? token;
  final bool readFails;
  bool wiped = false;

  @override
  dynamic noSuchMethod(Invocation i) {
    switch (i.memberName) {
      case #read:
        return readFails ? Future<String?>.error(PlatformException(code: 'keystore', message: 'bad key')) : Future<String?>.value(token);
      case #deleteAll:
        wiped = true;
        return Future<void>.value();
      default:
        return Future<void>.value();
    }
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  void engine({bool setSessionFails = false}) {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(const MethodChannel('sarthi/engine'), (call) async {
      if (call.method == 'setSession' && setSessionFails) throw PlatformException(code: 'engine_error', message: 'keystore broke');
      return call.method == 'getState' ? {'mode': 'idle'} : null;
    });
  }

  setUp(() => SharedPreferences.setMockInitialValues({'seen_welcome': true, 'setup_done': true}));

  AppState make(_Storage storage, http.Response Function(http.Request) answer) => AppState(
        api: ApiClient(baseUrl: 'http://server', client: MockClient((r) async => answer(r))),
        storage: storage,
      );

  test('unreadable secure storage no longer leaves the app on the loading screen: it goes to login', () async {
    engine();
    final storage = _Storage(readFails: true);
    final state = make(storage, (r) => http.Response('{}', 500));
    await state.start();
    expect(state.stage, Stage.login);
    expect(storage.wiped, isTrue);
  });

  test('an engine/Keystore failure while starting does not block the app from opening', () async {
    engine(setSessionFails: true);
    final state = make(_Storage(token: 'tok'), (r) {
      if (r.url.path == '/v1/me') return http.Response(jsonEncode(fixtures.me), 200);
      return http.Response('[]', 200);
    });
    await state.start();
    expect(state.stage, Stage.home);
    expect(state.me?.firstName, 'Priya');
  });

  test('server down on start: the app opens at Home (offline) instead of waiting', () async {
    engine();
    final state = make(_Storage(token: 'tok'), (r) => http.Response('', 503));
    await state.start();
    expect(state.stage, Stage.home);
  });

  test('an ended session goes to login', () async {
    engine();
    final state = make(_Storage(token: 'old'), (r) => http.Response(jsonEncode({'error': 'not_logged_in', 'message': 'Please log in again.'}), 401));
    await state.start();
    expect(state.stage, Stage.login);
  });
}
