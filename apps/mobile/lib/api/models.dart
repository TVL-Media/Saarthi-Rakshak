// The server's replies, as written in docs/app-api.md (source of truth: packages/shared).

DateTime? _date(Object? v) => v == null ? null : DateTime.parse(v as String).toLocal();
String? _str(Object? v) => v as String?;

class Me {
  Me({
    required this.id,
    required this.name,
    required this.phone,
    required this.bloodGroup,
    required this.photoUrl,
    required this.consentGiven,
    required this.guardiansCount,
    required this.acceptedGuardiansCount,
    required this.rules,
  });

  final String id;
  final String? name;
  final String phone;
  final String? bloodGroup;
  final String? photoUrl;
  final bool consentGiven;
  final int guardiansCount;
  final int acceptedGuardiansCount;
  final Map<String, num> rules;

  String get firstName => (name ?? '').trim().split(RegExp(r'\s+')).first;

  /// A safety rule from Settings, e.g. 'sos.countdown_seconds'.
  int rule(String key, int fallback) => rules[key]?.round() ?? fallback;

  factory Me.fromJson(Map<String, dynamic> j) => Me(
        id: j['id'] as String,
        name: _str(j['name']),
        phone: j['phone'] as String,
        bloodGroup: _str(j['bloodGroup']),
        photoUrl: _str(j['photoUrl']),
        consentGiven: j['consentGiven'] as bool,
        guardiansCount: j['guardiansCount'] as int,
        acceptedGuardiansCount: j['acceptedGuardiansCount'] as int,
        rules: (j['rules'] as Map<String, dynamic>).map((k, v) => MapEntry(k, v as num)),
      );
}

class Guardian {
  Guardian({
    required this.id,
    required this.name,
    required this.relation,
    required this.phoneMasked,
    required this.phone,
    required this.status,
  });

  final String id;
  final String name;
  final String? relation;
  final String? phoneMasked;
  final String? phone;

  /// pending, accepted or declined.
  final String status;

  factory Guardian.fromJson(Map<String, dynamic> j) => Guardian(
        id: j['id'] as String,
        name: j['name'] as String,
        relation: _str(j['relation']),
        phoneMasked: _str(j['phoneMasked']),
        phone: _str(j['phone']),
        status: j['status'] as String,
      );

  Map<String, dynamic> toJson() => {
        'id': id,
        'name': name,
        'relation': relation,
        'phoneMasked': phoneMasked,
        'phone': phone,
        'status': status,
      };
}

class SosGuardian {
  SosGuardian({
    required this.guardianId,
    required this.name,
    required this.alertedAt,
    required this.openedAt,
    required this.respondingAt,
  });

  final String guardianId;
  final String name;
  final DateTime? alertedAt;
  final DateTime? openedAt;
  final DateTime? respondingAt;

  String get statusText => respondingAt != null
      ? 'Responding'
      : openedAt != null
          ? 'Seen your location'
          : alertedAt != null
              ? 'Alerted'
              : 'Sending…';

  factory SosGuardian.fromJson(Map<String, dynamic> j) => SosGuardian(
        guardianId: j['guardianId'] as String,
        name: j['name'] as String,
        alertedAt: _date(j['alertedAt']),
        openedAt: _date(j['openedAt']),
        respondingAt: _date(j['respondingAt']),
      );
}

class Sos {
  Sos({
    required this.id,
    required this.status,
    required this.isTest,
    required this.startedAt,
    required this.endedAt,
    required this.guardians,
  });

  final String id;
  final String status;
  final bool isTest;
  final DateTime startedAt;
  final DateTime? endedAt;
  final List<SosGuardian> guardians;

  bool get anyoneResponding => guardians.any((g) => g.respondingAt != null);

  factory Sos.fromJson(Map<String, dynamic> j) => Sos(
        id: j['id'] as String,
        status: j['status'] as String,
        isTest: j['isTest'] as bool,
        startedAt: _date(j['startedAt'])!,
        endedAt: _date(j['endedAt']),
        guardians: (j['guardians'] as List).map((g) => SosGuardian.fromJson(g as Map<String, dynamic>)).toList(),
      );
}

class Checkin {
  Checkin({required this.id, required this.reason, required this.status, required this.askedAt});

  final String id;

  /// stopped, off_route or late.
  final String reason;

  /// pending, fine, traffic_pause, sos or no_reply.
  final String status;
  final DateTime askedAt;

  factory Checkin.fromJson(Map<String, dynamic> j) => Checkin(
        id: j['id'] as String,
        reason: j['reason'] as String,
        status: j['status'] as String,
        askedAt: _date(j['askedAt'])!,
      );
}

class Place {
  const Place({required this.lat, required this.lng, required this.label});
  final double lat;
  final double lng;
  final String label;
}

class Journey {
  Journey({
    required this.id,
    required this.status,
    required this.destination,
    required this.expectedArrivalAt,
    required this.startedAt,
    required this.endedAt,
    required this.openCheckin,
    required this.checkinsPausedUntil,
    required this.route,
  });

  final String id;
  final String status;
  final Place destination;
  final DateTime expectedArrivalAt;
  final DateTime startedAt;
  final DateTime? endedAt;
  final Checkin? openCheckin;
  final DateTime? checkinsPausedUntil;
  final String? route;

  factory Journey.fromJson(Map<String, dynamic> j) {
    final d = j['destination'] as Map<String, dynamic>;
    return Journey(
      id: j['id'] as String,
      status: j['status'] as String,
      destination: Place(
        lat: (d['lat'] as num).toDouble(),
        lng: (d['lng'] as num).toDouble(),
        label: d['label'] as String,
      ),
      expectedArrivalAt: _date(j['expectedArrivalAt'])!,
      startedAt: _date(j['startedAt'])!,
      endedAt: _date(j['endedAt']),
      openCheckin: j['openCheckin'] == null ? null : Checkin.fromJson(j['openCheckin'] as Map<String, dynamic>),
      checkinsPausedUntil: _date(j['checkinsPausedUntil']),
      route: _str(j['route']),
    );
  }
}

class SavedPlace {
  SavedPlace({
    required this.id,
    required this.label,
    required this.name,
    required this.address,
    required this.lat,
    required this.lng,
  });

  final String id;

  /// home, work or other.
  final String label;
  final String name;
  final String? address;
  final double lat;
  final double lng;

  factory SavedPlace.fromJson(Map<String, dynamic> j) => SavedPlace(
        id: j['id'] as String,
        label: j['label'] as String,
        name: j['name'] as String,
        address: _str(j['address']),
        lat: (j['lat'] as num).toDouble(),
        lng: (j['lng'] as num).toDouble(),
      );
}

class HistoryItem {
  HistoryItem({
    required this.type,
    required this.id,
    required this.status,
    required this.isTest,
    required this.trigger,
    required this.destinationLabel,
    required this.startedAt,
    required this.endedAt,
  });

  final String type;
  final String id;
  final String status;
  final bool isTest;
  final String? trigger;
  final String? destinationLabel;
  final DateTime startedAt;
  final DateTime? endedAt;

  factory HistoryItem.fromJson(Map<String, dynamic> j) => HistoryItem(
        type: j['type'] as String,
        id: j['id'] as String,
        status: j['status'] as String,
        isTest: j['isTest'] as bool,
        trigger: _str(j['trigger']),
        destinationLabel: _str(j['destinationLabel']),
        startedAt: _date(j['startedAt'])!,
        endedAt: _date(j['endedAt']),
      );
}

class HistoryPage {
  HistoryPage(this.items, this.nextCursor);
  final List<HistoryItem> items;
  final String? nextCursor;
}

class TimelineEntry {
  TimelineEntry(this.at, this.kind, this.text);
  final DateTime at;
  final String kind;
  final String text;
}

class AudioClip {
  AudioClip({
    required this.id,
    required this.recordedAt,
    required this.durationS,
    required this.keep,
    required this.deleteAfter,
  });

  final String id;
  final DateTime recordedAt;
  final int? durationS;
  final bool keep;
  final DateTime deleteAfter;

  factory AudioClip.fromJson(Map<String, dynamic> j) => AudioClip(
        id: j['id'] as String,
        recordedAt: _date(j['recordedAt'])!,
        durationS: j['durationS'] as int?,
        keep: j['keep'] as bool,
        deleteAfter: _date(j['deleteAfter'])!,
      );
}

class HistoryDetail {
  HistoryDetail(this.item, this.timeline, this.clips);
  final HistoryItem item;
  final List<TimelineEntry> timeline;
  final List<AudioClip> clips;

  factory HistoryDetail.fromJson(Map<String, dynamic> j) => HistoryDetail(
        HistoryItem.fromJson(j['item'] as Map<String, dynamic>),
        (j['timeline'] as List)
            .map((e) => e as Map<String, dynamic>)
            .map((e) => TimelineEntry(_date(e['at'])!, e['kind'] as String, e['text'] as String))
            .toList(),
        (j['clips'] as List).map((c) => AudioClip.fromJson(c as Map<String, dynamic>)).toList(),
      );
}

class UploadLink {
  UploadLink(this.key, this.uploadUrl, this.headers);
  final String key;
  final String uploadUrl;
  final Map<String, String> headers;

  factory UploadLink.fromJson(Map<String, dynamic> j) => UploadLink(
        j['key'] as String,
        j['uploadUrl'] as String,
        (j['headers'] as Map<String, dynamic>).map((k, v) => MapEntry(k, v as String)),
      );
}
