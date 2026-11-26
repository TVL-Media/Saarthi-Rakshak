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
