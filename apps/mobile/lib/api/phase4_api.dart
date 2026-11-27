import 'api_client.dart';

// Phase 4 calls: Night Mode, Safe Places, Women Safety, Men's Safety + Legal Support, Child Safety.
// The answers are read as plain maps; every field is optional so an older or newer server never
// crashes a screen. Contract: docs/app-api-phase4.md.

Map<String, dynamic> _obj(Object? v) => (v as Map?)?.cast<String, dynamic>() ?? <String, dynamic>{};
List<Map<String, dynamic>> _items(Object? v) =>
    ((v as List?) ?? const []).map((e) => (e as Map).cast<String, dynamic>()).toList();

/// The server does not have this Phase 4 call (or the switch is off): show "not available yet".
bool phase4Unavailable(Object error) => error is ApiException && (error.status == 404 || error.status == 501);

class SafePlaceReply {
  SafePlaceReply(this.items, this.providerAvailable, this.providerMessage, this.disclaimer);
  final List<Map<String, dynamic>> items;
  final bool providerAvailable;
  final String? providerMessage;
  final String? disclaimer;
}

extension Phase4Api on ApiClient {
  Future<bool> nightModeActive() async => _obj(await send('GET', '/v1/night-mode'))['active'] == true;
  Future<void> setNightMode(bool on) => send('PUT', '/v1/night-mode', body: {'active': on});

  Future<SafePlaceReply> safePlaces(double lat, double lng, {String? category, int radiusM = 3000}) async {
    final j = _obj(await send('GET', '/v1/safe-places', query: {
      'lat': '$lat',
      'lng': '$lng',
      'radiusM': '$radiusM',
      'category': ?category,
    }));
    return SafePlaceReply(_items(j['items']), j['providerAvailable'] != false, j['providerMessage'] as String?,
        j['disclaimer'] as String?);
  }

  Future<({List<Map<String, dynamic>> items, String? disclaimer})> guidance({String? situation}) async {
    final j = _obj(await send('GET', '/v1/guidance', query: {'situation': ?situation}));
    return (items: _items(j['items']), disclaimer: j['disclaimer'] as String?);
  }

  Future<List<Map<String, dynamic>>> partners(String kind, {String? category, String? city}) async =>
      _items(_obj(await send('GET', '/v1/partners', query: {
        'kind': kind,
        'category': ?category,
        if (city != null && city.isNotEmpty) 'city': city,
      }))['items']);

  Future<List<Map<String, dynamic>>> partnerRequests() async =>
      _items(_obj(await send('GET', '/v1/partner-requests'))['items']);

  Future<Map<String, dynamic>> createPartnerRequest(Map<String, dynamic> body) async =>
      _obj(await send('POST', '/v1/partner-requests', body: body));

  Future<Map<String, dynamic>> partnerRequest(String id) async => _obj(await send('GET', '/v1/partner-requests/$id'));

  Future<void> closePartnerRequest(String id) => send('POST', '/v1/partner-requests/$id/close');

  Future<List<Map<String, dynamic>>> incidentReports(String group) async =>
      _items(_obj(await send('GET', '/v1/incident-reports', query: {'group': group}))['items']);

  Future<Map<String, dynamic>> saveIncidentReport(String id, Map<String, dynamic> body) async =>
      _obj(await send('PUT', '/v1/incident-reports/$id', body: body));

  Future<Map<String, dynamic>> incidentReport(String id) async => _obj(await send('GET', '/v1/incident-reports/$id'));

  Future<void> deleteIncidentDraft(String id) => send('POST', '/v1/incident-reports/$id/delete');

  // ---- Child safety ----
  Future<List<Map<String, dynamic>>> childLinks() async => _items(_obj(await send('GET', '/v1/child/links'))['items']);

  Future<Map<String, dynamic>> createChildLink(String id, String name, String phone) async =>
      _obj(await send('POST', '/v1/child/links', body: {'id': id, 'childName': name, 'childPhone': phone}));

  Future<void> revokeChildLink(String id) => send('POST', '/v1/child/links/$id/revoke');

  Future<List<Map<String, dynamic>>> childZones(String id) async =>
      _items(_obj(await send('GET', '/v1/child/links/$id/zones'))['items']);

  Future<void> saveChildZone(String linkId, String zoneId, Map<String, dynamic> body) =>
      send('PUT', '/v1/child/links/$linkId/zones/$zoneId', body: body);

  Future<void> deleteChildZone(String linkId, String zoneId) => send('DELETE', '/v1/child/links/$linkId/zones/$zoneId');

  Future<List<Map<String, dynamic>>> childRoutes(String id) async =>
      _items(_obj(await send('GET', '/v1/child/links/$id/routes'))['items']);

  Future<void> deleteChildRoute(String linkId, String routeId) =>
      send('DELETE', '/v1/child/links/$linkId/routes/$routeId');

  Future<List<Map<String, dynamic>>> childAlerts(String id) async =>
      _items(_obj(await send('GET', '/v1/child/links/$id/alerts'))['items']);

  Future<void> acknowledgeChildAlert(String alertId) => send('POST', '/v1/child/alerts/$alertId/acknowledge');

  Future<Map<String, dynamic>> childInvitations() async => _obj(await send('GET', '/v1/child/invitations'));

  Future<void> answerChildInvitation(String id, bool accept) =>
      send('POST', '/v1/child/invitations/$id/${accept ? 'accept' : 'decline'}');

  Future<void> postChildLocation(double lat, double lng, double? accuracyM, DateTime at) => send('POST', '/v1/child/location',
      body: {'lat': lat, 'lng': lng, 'accuracyM': accuracyM, 'recordedAt': at.toUtc().toIso8601String()});
}

// ---- Phase 4, second group: Chhupa Rakshak, School, Cyber, Glasses, Safer Route, Police handoff ----
extension Phase4bApi on ApiClient {
  Future<Map<String, dynamic>> monitoringOverview(String linkId) async => _obj(await send('GET', '/v1/monitoring/$linkId'));

  Future<Map<String, dynamic>> setMonitoringConsent(String linkId, bool enabled, {bool accept = false}) async =>
      _obj(await send('PUT', '/v1/monitoring/$linkId/consent', body: {'enabled': enabled, 'accept': accept}));

  Future<Map<String, dynamic>> startMonitoring(String linkId, String id, String reason) async =>
      _obj(await send('POST', '/v1/monitoring/$linkId/sessions', body: {'id': id, 'reason': reason}));

  Future<Map<String, dynamic>> monitoringSession(String id) async => _obj(await send('GET', '/v1/monitoring-sessions/$id'));

  Future<Map<String, dynamic>> stopMonitoring(String id) async => _obj(await send('POST', '/v1/monitoring-sessions/$id/stop'));

  Future<Map<String, dynamic>> childMonitoring() async => _obj(await send('GET', '/v1/child/monitoring'));

  Future<void> postMonitoringSample(String id, double lat, double lng, double? accuracyM) =>
      send('POST', '/v1/child/monitoring/$id/location', body: {'lat': lat, 'lng': lng, 'accuracyM': accuracyM});

  Future<Map<String, dynamic>> childStopMonitoring(String id) async =>
      _obj(await send('POST', '/v1/child/monitoring/$id/stop'));

  Future<List<Map<String, dynamic>>> schoolDirectory(String q) async =>
      _items(_obj(await send('GET', '/v1/schools', query: {if (q.isNotEmpty) 'q': q}))['items']);

  Future<List<Map<String, dynamic>>> schoolLinks() async => _items(_obj(await send('GET', '/v1/school-links'))['items']);

  Future<void> createSchoolLink(String id, String schoolId, String childName, String studentRef) => send('POST', '/v1/school-links',
      body: {'id': id, 'schoolId': schoolId, 'childName': childName, 'studentRef': studentRef});

  Future<void> revokeSchoolLink(String id) => send('POST', '/v1/school-links/$id/revoke');

  Future<Map<String, dynamic>> schoolEvents(String id) async => _obj(await send('GET', '/v1/school-links/$id/events'));

  Future<Map<String, dynamic>> cyberOverview(String linkId) async => _obj(await send('GET', '/v1/cyber/$linkId'));

  Future<Map<String, dynamic>> setCyberSource(String linkId, bool enabled, {bool accept = false}) async =>
      _obj(await send('PUT', '/v1/cyber/$linkId/source', body: {'enabled': enabled, 'accept': accept}));

  Future<Map<String, dynamic>> cyberAnalyse(String linkId, String text) async =>
      _obj(await send('POST', '/v1/cyber/$linkId/analyse', body: {'text': text}));

  Future<Map<String, dynamic>> cyberReview(String flagId, String status, {String? note}) async =>
      _obj(await send('POST', '/v1/cyber/flags/$flagId/review', body: {'status': status, 'note': ?note}));

  Future<Map<String, dynamic>> glassesModels() async => _obj(await send('GET', '/v1/glasses/models'));

  Future<List<Map<String, dynamic>>> myGlasses() async => _items(_obj(await send('GET', '/v1/glasses'))['items']);

  Future<void> pairGlasses(String id, String modelId, String deviceId, String firmware) =>
      send('POST', '/v1/glasses/pair', body: {'id': id, 'modelId': modelId, 'deviceId': deviceId, 'firmware': firmware});

  Future<void> unpairGlasses(String id) => send('POST', '/v1/glasses/$id/unpair');

  Future<Map<String, dynamic>> safeRoutes(double fromLat, double fromLng, double toLat, double toLng, String mode) async =>
      _obj(await send('POST', '/v1/safe-route/routes', body: {
        'from': {'lat': fromLat, 'lng': fromLng},
        'to': {'lat': toLat, 'lng': toLng},
        'mode': mode,
      }));

  Future<void> safeRouteFeedback(String id, String? scoreId, String kind, String message) => send('POST', '/v1/safe-route/feedback',
      body: {'id': id, 'routeScoreId': scoreId, 'kind': kind, 'message': message});

  Future<Map<String, dynamic>> sosHandoff(String sosId) async => _obj(await send('GET', '/v1/sos-handoff/$sosId'));
}
