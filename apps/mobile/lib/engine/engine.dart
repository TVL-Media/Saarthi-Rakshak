import 'dart:async';

import 'package:flutter/services.dart';

import '../api/models.dart';

/// What the native safety engine (Kotlin, android/.../engine) is doing right now.
class EngineState {
  EngineState(Map<dynamic, dynamic> m)
      : mode = (m['mode'] as String?) ?? 'idle',
        sosId = m['sosId'] as String?,
        sosSentToServer = (m['sosSentToServer'] as bool?) ?? false,
        simSmsSentTo = ((m['simSmsSentTo'] as List?) ?? const []).cast<String>(),
        journeyId = m['journeyId'] as String?,
        lastLat = (m['lastLat'] as num?)?.toDouble(),
        lastLng = (m['lastLng'] as num?)?.toDouble(),
        lastFixAt = m['lastFixAt'] == null ? null : DateTime.fromMillisecondsSinceEpoch(m['lastFixAt'] as int),
        accuracyM = (m['accuracyM'] as num?)?.toDouble(),
        batteryPct = m['batteryPct'] as int?,
        online = (m['online'] as bool?) ?? true,
        queued = (m['queued'] as int?) ?? 0,
        recording = (m['recording'] as bool?) ?? false,
        audioOff = (m['audioOff'] as bool?) ?? false,
        audioError = m['audioError'] as String?,
        audioClips = (m['audioClips'] as int?) ?? 0,
        audioSavedSeconds = (m['audioSavedSeconds'] as int?) ?? 0,
        audioClipSince = (m['audioClipSince'] as int?) ?? 0,
        locationOff = (m['locationOff'] as bool?) ?? false,
        journeyStatus = m['journeyStatus'] as String?;

  /// idle, sos, journey or sos_journey.
  final String mode;
  final String? sosId;

  /// The server has the SOS (guardians alerted by our SMS provider).
  final bool sosSentToServer;

  /// Guardians reached by SMS from this phone's SIM (no internet at the time).
  final List<String> simSmsSentTo;
  final String? journeyId;
  final double? lastLat;
  final double? lastLng;
  final DateTime? lastFixAt;
  final double? accuracyM;
  final int? batteryPct;
  final bool online;

  /// Items waiting to be sent (offline).
  final int queued;
  final bool recording;
  final bool audioOff;

  /// Why recording could not start (the engine keeps trying); null when fine.
  final String? audioError;

  /// 30-second clips saved on this phone for the running SOS, and their total length.
  final int audioClips;
  final int audioSavedSeconds;

  /// When the clip being recorded now started (ms since epoch; 0 when not recording).
  final int audioClipSince;

  /// Total recorded in this SOS so far, including the clip being recorded now.
  Duration audioRecorded(DateTime now) {
    final current = recording && audioClipSince > 0 ? now.millisecondsSinceEpoch - audioClipSince : 0;
    return Duration(seconds: audioSavedSeconds) + Duration(milliseconds: current.clamp(0, 120000));
  }
  final bool locationOff;

  /// on_route, stopped, off_route, late (journey only).
  final String? journeyStatus;

  bool get sosActive => sosId != null;
  bool get journeyActive => journeyId != null;

  static final idle = EngineState(const {});
}

/// An event from the engine to the screens.
class EngineEvent {
  EngineEvent(this.type, this.data);

  /// `state` (EngineState changed), `checkin` (show the check-in alert), `launch` (opened from the
  /// widget, tile or a notification: data['action'] is `sos` or `checkin`).
  final String type;
  final Map<dynamic, dynamic> data;
}

/// The bridge to the Kotlin safety engine. Everything that must keep working with the screen off
/// or the app closed (SOS, location, audio, SIM SMS, journey checks) runs there.
class SafetyEngine {
  SafetyEngine({MethodChannel? channel, EventChannel? events})
      : _ch = channel ?? const MethodChannel('sarthi/engine'),
        _ev = events ?? const EventChannel('sarthi/engine/events');

  final MethodChannel _ch;
  final EventChannel _ev;
  Stream<EngineEvent>? _stream;

  Stream<EngineEvent> get events => _stream ??= _ev
      .receiveBroadcastStream()
      .map((e) => e as Map<dynamic, dynamic>)
      .map((e) => EngineEvent(e['type'] as String, (e['data'] as Map?) ?? const {}))
      .asBroadcastStream();

  /// The server address and our session, so the engine can work without the app open.
  Future<void> setSession(String apiUrl, String token, String userName) =>
      _ch.invokeMethod('setSession', {'apiUrl': apiUrl, 'token': token, 'userName': userName});

  Future<void> clearSession() => _ch.invokeMethod('clearSession');

  /// Guardians (with full numbers) for SMS from the SIM when there is no internet.
  Future<void> cacheGuardians(List<Guardian> guardians) => _ch.invokeMethod('cacheGuardians', {
        'guardians': guardians
            .where((g) => g.status != 'declined' && g.phone != null)
            .map((g) => {'id': g.id, 'name': g.name, 'phone': g.phone, 'status': g.status})
            .toList(),
      });

  /// Starts the SOS after the countdown: the phone acts first (works offline).
  Future<void> startSos({
    required String sosId,
    required String trigger,
    String? journeyId,
    required int noInternetSmsAfterSeconds,
  }) =>
      _ch.invokeMethod('startSos', {
        'sosId': sosId,
        'trigger': trigger,
        'journeyId': journeyId,
        'startedAt': DateTime.now().millisecondsSinceEpoch,
        'simFallbackSeconds': noInternetSmsAfterSeconds,
      });

  /// "I'm safe": stops tracking and recording; the end is sent (now or when back online).
  Future<void> endSos(String sosId) => _ch.invokeMethod('endSos', {'sosId': sosId});

  Future<void> startJourney({
    required Journey journey,
    required Map<String, num> rules,
  }) =>
      _ch.invokeMethod('startJourney', {
        'journeyId': journey.id,
        'destLat': journey.destination.lat,
        'destLng': journey.destination.lng,
        'arriveBy': journey.expectedArrivalAt.millisecondsSinceEpoch,
        'route': journey.route,
        'stoppedMinutes': rules['checkin.stopped_minutes'] ?? 3,
        'offRouteMetres': rules['checkin.off_route_metres'] ?? 500,
        'lateMinutes': rules['checkin.late_minutes'] ?? 15,
        'replyWaitMinutes': rules['checkin.reply_wait_minutes'] ?? 2,
      });

  Future<void> stopJourney() => _ch.invokeMethod('stopJourney');

  /// The user answered a check-in: stops the alarm; `traffic_pause` pauses checks.
  Future<void> checkinAnswered(String reason, String answer, {int pauseMinutes = 10}) =>
      _ch.invokeMethod('checkinAnswered', {'reason': reason, 'answer': answer, 'pauseMinutes': pauseMinutes});

  /// Shows a sample check-in (nothing is sent).
  Future<void> previewCheckin() => _ch.invokeMethod('previewCheckin');

  Future<EngineState> state() async =>
      EngineState((await _ch.invokeMethod<Map<dynamic, dynamic>>('getState')) ?? const {});

  /// `sos` or `checkin` when the app was opened from the widget, tile or a notification.
  Future<Map<dynamic, dynamic>?> takeLaunchAction() => _ch.invokeMethod('takeLaunchAction');

  /// After the user changed permissions: the engine starts what is now allowed (audio, location).
  Future<void> resume() => _ch.invokeMethod('resume');

  /// SOS recordings kept on this phone (newest first); only this phone can play them.
  Future<List<LocalClip>> listClips({String? sosId}) async {
    final list = await _ch.invokeMethod<List<dynamic>>('listClips', {'sosId': sosId}) ?? const [];
    return list.map((m) => LocalClip(m as Map<dynamic, dynamic>)).toList();
  }

  Future<void> playClip(String id) => _ch.invokeMethod('playClip', {'id': id});

  Future<Map<dynamic, dynamic>> deviceInfo() async =>
      (await _ch.invokeMethod<Map<dynamic, dynamic>>('deviceInfo')) ?? const {};

  Future<bool> batteryOptimisationOff() async => (await _ch.invokeMethod<bool>('batteryOptimisationOff')) ?? false;

  Future<void> askBatteryOptimisationOff() => _ch.invokeMethod('askBatteryOptimisationOff');

  /// Plays an encrypted clip recorded on this phone (decrypted on the phone only).
  Future<void> playEncrypted(List<int> bytes) => _ch.invokeMethod('playEncrypted', {'bytes': Uint8List.fromList(bytes)});

  Future<void> stopPlayback() => _ch.invokeMethod('stopPlayback');

  Future<void> startRingtone() => _ch.invokeMethod('startRingtone');

  Future<void> stopRingtone() => _ch.invokeMethod('stopRingtone');

  /// Opens the phone's contact picker (no contacts permission needed). Null when cancelled.
  Future<({String name, String phone})?> pickContact() async {
    final r = await _ch.invokeMethod<Map<dynamic, dynamic>>('pickContact');
    if (r == null) return null;
    return (name: (r['name'] as String?) ?? '', phone: (r['phone'] as String?) ?? '');
  }
}

/// One SOS recording kept (encrypted) on this phone.
class LocalClip {
  LocalClip(Map<dynamic, dynamic> m)
      : id = m['id'] as String,
        sosId = m['sosId'] as String,
        recordedAt = DateTime.fromMillisecondsSinceEpoch((m['recordedAt'] as num).toInt()),
        seconds = (m['seconds'] as num?)?.toInt() ?? 0,
        uploaded = (m['uploaded'] as bool?) ?? false;

  final String id;
  final String sosId;
  final DateTime recordedAt;
  final int seconds;
  final bool uploaded;
}
