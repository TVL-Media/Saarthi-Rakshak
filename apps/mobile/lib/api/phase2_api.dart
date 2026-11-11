import 'api_client.dart';
import 'models.dart';

// Phase 2 calls and models (server: server/src/app/phase2, contract: packages/shared/phase2-api).

DateTime? _date(Object? v) => v == null ? null : DateTime.parse(v as String).toLocal();
Map<String, dynamic> _obj(Object? v) => v as Map<String, dynamic>;
List<dynamic> _list(Object? v) => v as List<dynamic>;

class SosTriggerSettings {
  SosTriggerSettings({
    this.shakeMode = 'off',
    this.voiceOn = false,
    this.driveMode = false,
    this.fallOn = false,
    this.quietCountdown = false,
    this.journeySosButton = true,
  });

  /// off / journey / always
  final String shakeMode;
  final bool voiceOn;
  final bool driveMode;
  final bool fallOn;
  final bool quietCountdown;
  final bool journeySosButton;

  factory SosTriggerSettings.fromJson(Map<String, dynamic> j) => SosTriggerSettings(
        shakeMode: j['shakeMode'] as String? ?? 'off',
        voiceOn: j['voiceOn'] as bool? ?? false,
        driveMode: j['driveMode'] as bool? ?? false,
        fallOn: j['fallOn'] as bool? ?? false,
        quietCountdown: j['quietCountdown'] as bool? ?? false,
        journeySosButton: j['journeySosButton'] as bool? ?? true,
      );

  Map<String, Object?> toJson() => {
        'shakeMode': shakeMode,
        'voiceOn': voiceOn,
        'driveMode': driveMode,
        'fallOn': fallOn,
        'quietCountdown': quietCountdown,
        'journeySosButton': journeySosButton,
      };

  SosTriggerSettings copyWith({
    String? shakeMode,
    bool? voiceOn,
    bool? driveMode,
    bool? fallOn,
    bool? quietCountdown,
    bool? journeySosButton,
  }) =>
      SosTriggerSettings(
        shakeMode: shakeMode ?? this.shakeMode,
        voiceOn: voiceOn ?? this.voiceOn,
        driveMode: driveMode ?? this.driveMode,
        fallOn: fallOn ?? this.fallOn,
        quietCountdown: quietCountdown ?? this.quietCountdown,
        journeySosButton: journeySosButton ?? this.journeySosButton,
      );
}

class DailyTracking {
  DailyTracking({required this.enabled, this.pausedUntil, this.retentionDays = 30, this.consentVersion});
  final bool enabled;
  final DateTime? pausedUntil;
  final int retentionDays;
  final String? consentVersion;

  bool get paused => pausedUntil != null && pausedUntil!.isAfter(DateTime.now());

  factory DailyTracking.fromJson(Map<String, dynamic> j) => DailyTracking(
        enabled: j['enabled'] as bool? ?? false,
        pausedUntil: _date(j['pausedUntil']),
        retentionDays: (j['retentionDays'] as num?)?.toInt() ?? 30,
        consentVersion: j['consentVersion'] as String?,
      );

  static final off = DailyTracking(enabled: false);
}

class TimelineStop {
  TimelineStop(this.lat, this.lng, this.arrivedAt, this.leftAt, this.minutes);
  final double lat;
  final double lng;
  final DateTime arrivedAt;
  final DateTime leftAt;
  final int minutes;
  String? name;
}

class TimelineRoute {
  TimelineRoute(this.from, this.to, this.distanceM, this.points);
  final DateTime from;
  final DateTime to;
  final int distanceM;
  final List<(double, double)> points;
}

class Timeline {
  Timeline(this.date, this.stops, this.routes, this.pointsCount);
  final String date;
  final List<TimelineStop> stops;
  final List<TimelineRoute> routes;
  final int pointsCount;

  int get distanceM => routes.fold(0, (s, r) => s + r.distanceM);
  int get movingMinutes => routes.fold(0, (s, r) => s + r.to.difference(r.from).inMinutes);

  factory Timeline.fromJson(Map<String, dynamic> j) => Timeline(
        j['date'] as String,
        _list(j['stops'])
            .map((s) => _obj(s))
            .map((s) => TimelineStop((s['lat'] as num).toDouble(), (s['lng'] as num).toDouble(),
                _date(s['arrivedAt'])!, _date(s['leftAt'])!, (s['minutes'] as num).toInt()))
            .toList(),
        _list(j['routes']).map((r) => _obj(r)).map((r) {
          final pts = _list(r['points']).map((p) {
            final l = _list(p);
            return ((l[0] as num).toDouble(), (l[1] as num).toDouble());
          }).toList();
          return TimelineRoute(_date(r['from'])!, _date(r['to'])!, (r['distanceM'] as num).toInt(), pts);
        }).toList(),
        (j['pointsCount'] as num).toInt(),
      );
}

class VaultKeyRecord {
  VaultKeyRecord(this.lockedKey, this.kdf, this.checkValue);
  final String lockedKey;
  final Map<String, dynamic> kdf;
  final String checkValue;
}

class EvidenceItem {
  EvidenceItem.fromJson(Map<String, dynamic> j)
      : id = j['id'] as String,
        kind = j['kind'] as String,
        incidentId = j['incidentId'] as String?,
        lockedFileKey = j['lockedFileKey'] as String,
        lockedDetails = j['lockedDetails'] as String,
        sha256 = j['sha256'] as String,
        capturedAt = _date(j['capturedAt'])!,
        receivedAt = _date(j['receivedAt'])!,
        sizeBytes = (j['sizeBytes'] as num).toInt(),
        hasFile = j['hasFile'] as bool,
        hidden = j['hidden'] as bool,
        deleteLockedUntil = _date(j['deleteLockedUntil'])!;

  final String id;

  /// audio, video, photo, file, detail, report
  final String kind;
  final String? incidentId;
  final String lockedFileKey;
  final String lockedDetails;
  final String sha256;
  final DateTime capturedAt;
  final DateTime receivedAt;
  final int sizeBytes;
  final bool hasFile;
  final bool hidden;
  final DateTime deleteLockedUntil;

  bool get locked => deleteLockedUntil.isAfter(DateTime.now());
}

class Incident {
  Incident.fromJson(Map<String, dynamic> j)
      : id = j['id'] as String,
        kind = j['kind'] as String,
        lockedDetails = j['lockedDetails'] as String,
        sosId = j['sosId'] as String?,
        itemsCount = (j['itemsCount'] as num).toInt(),
        createdAt = _date(j['createdAt'])!;
  final String id;

  /// blackmail, harassment, physical, sos, other
  final String kind;
  final String lockedDetails;
  final String? sosId;
  final int itemsCount;
  final DateTime createdAt;
}

class AccessLogEntry {
  AccessLogEntry.fromJson(Map<String, dynamic> j)
      : action = j['action'] as String,
        itemId = j['itemId'] as String?,
        incidentId = j['incidentId'] as String?,
        device = j['device'] as String?,
        at = _date(j['at'])!;
  final String action;
  final String? itemId;
  final String? incidentId;
  final String? device;
  final DateTime at;
}

class VaultUsage {
  VaultUsage(this.usedBytes, this.limitBytes, this.items);
  final int usedBytes;
  final int limitBytes;
  final int items;
}

class CommunityPost {
  CommunityPost.fromJson(Map<String, dynamic> j)
      : id = j['id'] as String,
        category = j['category'] as String,
        area = j['area'] as String,
        body = j['body'] as String,
        photoUrl = j['photoUrl'] as String?,
        official = j['official'] as bool? ?? false,
        createdAt = _date(j['createdAt'])!,
        status = j['status'] as String?,
        reason = j['reason'] as String?;
  final String id;
  final String category;
  final String area;
  final String body;
  final String? photoUrl;
  final bool official;
  final DateTime createdAt;

  /// My reports only: pending / published / rejected / removed.
  final String? status;
  final String? reason;
}

class RakshakApplication {
  RakshakApplication.fromJson(Map<String, dynamic> j)
      : id = j['id'] as String,
        status = j['status'] as String,
        reason = j['reason'] as String?,
        area = j['area'] as String,
        createdAt = _date(j['createdAt'])!,
        decidedAt = _date(j['decidedAt']);
  final String id;

  /// under_review / approved / rejected / withdrawn
  final String status;
  final String? reason;
  final String area;
  final DateTime createdAt;
  final DateTime? decidedAt;
}

class Plan {
  Plan.fromJson(Map<String, dynamic> j)
      : id = j['id'] as String,
        name = j['name'] as String,
        monthlyPriceInr = (j['monthlyPriceInr'] as num?)?.toInt(),
        yearlyPriceInr = (j['yearlyPriceInr'] as num?)?.toInt(),
        monthlyProductId = j['monthlyProductId'] as String?,
        yearlyProductId = j['yearlyProductId'] as String?,
        features = _list(j['features']).cast<String>(),
        evidenceStorageMb = (j['evidenceStorageMb'] as num).toInt(),
        onSale = j['onSale'] as bool? ?? false;
  final String id;
  final String name;
  final int? monthlyPriceInr;
  final int? yearlyPriceInr;
  final String? monthlyProductId;
  final String? yearlyProductId;
  final List<String> features;
  final int evidenceStorageMb;
  final bool onSale;
}

class PlansReply {
  PlansReply.fromJson(Map<String, dynamic> j)
      : plans = _list(j['plans']).map((p) => Plan.fromJson(_obj(p))).toList(),
        current = j['current'] as String,
        everythingFree = j['everythingFree'] as bool,
        renewsAt = _date(j['renewsAt']);
  final List<Plan> plans;
  final String current;
  final bool everythingFree;
  final DateTime? renewsAt;
}

String _day(DateTime d) =>
    '${d.year.toString().padLeft(4, '0')}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}';

extension Phase2Api on ApiClient {
  // ---- SOS triggers, photos, false alarms -------------------------------------------------------

  Future<SosTriggerSettings> sosTriggers() async => SosTriggerSettings.fromJson(_obj(await send('GET', '/v1/me/sos-triggers')));

  Future<SosTriggerSettings> saveSosTriggers(Map<String, Object?> change) async =>
      SosTriggerSettings.fromJson(_obj(await send('PUT', '/v1/me/sos-triggers', body: change)));

  Future<void> falseAlarm(String id, String trigger) =>
      send('POST', '/v1/sos/false-alarms', body: {'id': id, 'trigger': trigger});

  Future<UploadLink> sosPhotoUploadLink(String sosId, String photoId, int size) async =>
      UploadLink.fromJson(_obj(await send('POST', '/v1/sos/$sosId/photo-upload', body: {'photoId': photoId, 'sizeBytes': size})));

  Future<void> saveSosPhoto(String sosId, String photoId, String camera, DateTime takenAt) => send(
      'POST', '/v1/sos/$sosId/photos',
      body: {'photoId': photoId, 'camera': camera, 'takenAt': takenAt.toUtc().toIso8601String()});

  // ---- Full-day location, timeline ---------------------------------------------------------------

  Future<DailyTracking> dailyTracking() async => DailyTracking.fromJson(_obj(await send('GET', '/v1/me/daily-tracking')));

  Future<DailyTracking> saveDailyTracking(Map<String, Object?> change) async =>
      DailyTracking.fromJson(_obj(await send('PUT', '/v1/me/daily-tracking', body: change)));

  Future<Timeline> timeline(DateTime day) async =>
      Timeline.fromJson(_obj(await send('GET', '/v1/timeline', query: {'date': _day(day)})));

  Future<void> deleteDailyDay(DateTime day) => send('DELETE', '/v1/daily-locations', query: {'date': _day(day)});

  Future<void> deleteAllDaily() => send('DELETE', '/v1/daily-locations', query: {'all': 'true'});

  // ---- Vault ------------------------------------------------------------------------------------

  Future<void> vaultSetup(String lockedKey, Map<String, Object?> kdf, String checkValue) =>
      send('POST', '/v1/vault/setup', body: {'lockedKey': lockedKey, 'kdf': kdf, 'checkValue': checkValue});

  /// null = no vault set up yet on the server.
  Future<VaultKeyRecord?> vaultRecovery() async {
    try {
      final j = _obj(await send('GET', '/v1/vault/recovery'));
      return VaultKeyRecord(j['lockedKey'] as String, _obj(j['kdf']), j['checkValue'] as String);
    } on ApiException catch (e) {
      if (e.status == 404) return null;
      rethrow;
    }
  }

  Future<VaultUsage> vaultUsage() async {
    final j = _obj(await send('GET', '/v1/vault/usage'));
    return VaultUsage((j['usedBytes'] as num).toInt(), (j['limitBytes'] as num).toInt(), (j['items'] as num).toInt());
  }

  Future<UploadLink> evidenceUploadLink(String itemId, int size) async =>
      UploadLink.fromJson(_obj(await send('POST', '/v1/vault/items/upload', body: {'itemId': itemId, 'sizeBytes': size})));

  Future<EvidenceItem> saveEvidence(Map<String, Object?> body) async =>
      EvidenceItem.fromJson(_obj(await send('POST', '/v1/vault/items', body: body)));

  Future<List<EvidenceItem>> evidence() async =>
      _list(await send('GET', '/v1/vault/items')).map((e) => EvidenceItem.fromJson(_obj(e))).toList();

  Future<String> evidenceDownloadUrl(String id) async => _obj(await send('GET', '/v1/vault/items/$id/download'))['url'] as String;

  Future<EvidenceItem> updateEvidence(String id, Map<String, Object?> change) async =>
      EvidenceItem.fromJson(_obj(await send('PATCH', '/v1/vault/items/$id', body: change)));

  Future<void> deleteEvidence(String id) => send('DELETE', '/v1/vault/items/$id');

  Future<Incident> saveIncident(String id, String kind, String lockedDetails) async =>
      Incident.fromJson(_obj(await send('POST', '/v1/vault/incidents', body: {'id': id, 'kind': kind, 'lockedDetails': lockedDetails})));

  Future<Incident> updateIncident(String id, Map<String, Object?> change) async =>
      Incident.fromJson(_obj(await send('PATCH', '/v1/vault/incidents/$id', body: change)));

  Future<List<Incident>> incidents() async =>
      _list(await send('GET', '/v1/vault/incidents')).map((e) => Incident.fromJson(_obj(e))).toList();

  Future<void> addAccessLog(List<Map<String, Object?>> entries, {String? device}) =>
      send('POST', '/v1/vault/access-log', body: {'entries': entries, 'device': ?device});

  Future<List<AccessLogEntry>> accessLog() async =>
      _list(await send('GET', '/v1/vault/access-log')).map((e) => AccessLogEntry.fromJson(_obj(e))).toList();

  // ---- Community --------------------------------------------------------------------------------

  Future<List<String>> communityAreas() async => _list(_obj(await send('GET', '/v1/community/areas'))['areas']).cast<String>();

  Future<List<CommunityPost>> communityPosts(String? area) async =>
      _list(await send('GET', '/v1/community/posts', query: {'area': ?area}))
          .map((p) => CommunityPost.fromJson(_obj(p)))
          .toList();

  Future<UploadLink> communityPhotoLink(int size) async =>
      UploadLink.fromJson(_obj(await send('POST', '/v1/community/photo-upload', body: {'sizeBytes': size})));

  Future<CommunityPost> communityReport(Map<String, Object?> body) async =>
      CommunityPost.fromJson(_obj(await send('POST', '/v1/community/reports', body: body)));

  Future<List<CommunityPost>> myCommunityReports() async =>
      _list(await send('GET', '/v1/community/my-reports')).map((p) => CommunityPost.fromJson(_obj(p))).toList();

  Future<void> flagPost(String id, String reason) => send('POST', '/v1/community/posts/$id/flag', body: {'reason': reason});

  // ---- Rakshak ----------------------------------------------------------------------------------

  Future<UploadLink> rakshakDocLink(String document, int size) async =>
      UploadLink.fromJson(_obj(await send('POST', '/v1/rakshak/document-upload', body: {'document': document, 'sizeBytes': size})));

  Future<RakshakApplication> rakshakApply(Map<String, Object?> body) async =>
      RakshakApplication.fromJson(_obj(await send('POST', '/v1/rakshak/application', body: body)));

  Future<RakshakApplication?> rakshakApplication() async {
    final app = _obj(await send('GET', '/v1/rakshak/application'))['application'];
    return app == null ? null : RakshakApplication.fromJson(_obj(app));
  }

  Future<void> rakshakWithdraw() => send('DELETE', '/v1/rakshak/application');

  // ---- Plans ------------------------------------------------------------------------------------

  Future<PlansReply> plans() async => PlansReply.fromJson(_obj(await send('GET', '/v1/plans')));

  Future<PlansReply> verifyPurchase(String productId, String token) async => PlansReply.fromJson(
      _obj(await send('POST', '/v1/subscriptions/verify', body: {'productId': productId, 'purchaseToken': token})));
}
