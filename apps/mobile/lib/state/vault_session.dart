import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:cryptography/cryptography.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:path_provider/path_provider.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:uuid/uuid.dart';

import '../api/api_client.dart';
import '../api/phase2_api.dart';
import 'app_state.dart';

/// Why the vault cannot open (shown on the vault screen).
class VaultProblem implements Exception {
  VaultProblem(this.message);
  final String message;
  @override
  String toString() => message;
}

/// Details of one evidence item, encrypted on the phone (the server never sees them).
class ItemDetails {
  ItemDetails({this.note = '', this.fileName, this.mime, this.lat, this.lng, this.place, this.detailType, this.value});
  final String note;
  final String? fileName;
  final String? mime;
  final double? lat;
  final double? lng;
  final String? place;

  /// Detail items: phone / email / url / profile / other, and the value.
  final String? detailType;
  final String? value;

  Map<String, Object?> toJson() => {
        'note': note,
        'fileName': fileName,
        'mime': mime,
        'lat': lat,
        'lng': lng,
        'place': place,
        'detailType': detailType,
        'value': value,
      };

  factory ItemDetails.fromJson(Map<String, dynamic> j) => ItemDetails(
        note: j['note'] as String? ?? '',
        fileName: j['fileName'] as String?,
        mime: j['mime'] as String?,
        lat: (j['lat'] as num?)?.toDouble(),
        lng: (j['lng'] as num?)?.toDouble(),
        place: j['place'] as String?,
        detailType: j['detailType'] as String?,
        value: j['value'] as String?,
      );
}

/// Title, date and description of an incident (encrypted on the phone).
class IncidentDetails {
  IncidentDetails({required this.title, required this.date, this.description = ''});
  final String title;
  final DateTime date;
  final String description;

  Map<String, Object?> toJson() => {'title': title, 'date': date.toIso8601String(), 'description': description};

  factory IncidentDetails.fromJson(Map<String, dynamic> j) => IncidentDetails(
        title: j['title'] as String? ?? 'Incident',
        date: DateTime.tryParse(j['date'] as String? ?? '') ?? DateTime.now(),
        description: j['description'] as String? ?? '',
      );
}

/// A file waiting to be uploaded (kept encrypted on the phone until it is).
class PendingUpload {
  PendingUpload(this.id, this.kind, this.capturedAt);
  final String id;
  final String kind;
  final DateTime capturedAt;
}

/// The evidence vault while it is open. No backdoor:
/// - the vault opens with the user's password (Argon2id); fingerprint opening can be added, which
///   keeps the vault key on this phone in the Android Keystore;
/// - the server keeps the vault key only locked with the password: it cannot open the vault, and
///   nobody can reset the password (a forgotten password = evidence that cannot be opened);
/// - the key is in memory only while the vault is open (it locks after 2 minutes away);
/// - every file has its own key and is encrypted before it leaves the phone.
class VaultSession extends ChangeNotifier {
  VaultSession(this._app);
  final AppState _app;
  static const _uuid = Uuid();

  /// Argon2id settings for the password (a few seconds on a phone, slow for guessing).
  static const _kdf = {'memoryKiB': 19456, 'iterations': 2, 'parallelism': 1};

  String? _key;
  DateTime _lastUsed = DateTime.now();
  final Map<String, ItemDetails> _detailsCache = {};

  bool get isOpen => _key != null;

  /// Locks the vault: forgets the key and deletes opened (decrypted) files.
  void lock() {
    if (_key == null && _detailsCache.isEmpty) return;
    _key = null;
    _detailsCache.clear();
    unawaited(_wipeOpened());
    notifyListeners();
  }

  /// Back in the app: locks again after 2 minutes away.
  void resumed() {
    if (isOpen && DateTime.now().difference(_lastUsed) > const Duration(minutes: 2)) lock();
    _lastUsed = DateTime.now();
  }

  void touch() => _lastUsed = DateTime.now();

  Future<void> _wipeOpened() async {
    try {
      final dir = Directory('${(await getTemporaryDirectory()).path}/vault');
      if (await dir.exists()) await dir.delete(recursive: true);
    } catch (_) {}
  }

  // ---- Unlock -----------------------------------------------------------------------------------

  /// Tests only: answers the fingerprint / PIN prompt.
  @visibleForTesting
  static Future<bool> Function(String reason)? testAuth;

  /// Fingerprint, face or phone PIN. False if the user cancelled.
  Future<bool> _authenticate(String reason) async {
    if (testAuth != null) return testAuth!(reason);
    // Native prompt: fingerprint or the phone's PIN / pattern / password. These unlock the vault key
    // in the Keystore; a "weak" face unlock would pass a plain prompt but not open the key.
    try {
      return await _app.engine.vaultAuth(reason);
    } on PlatformException catch (e) {
      if (e.code == 'no_lock') {
        throw VaultProblem('Set a screen lock with a fingerprint on this phone first.');
      }
      return false;
    }
  }

  /// Fingerprint opening is set up on this phone (the vault key is kept in the Keystore).
  Future<bool> fingerprintOn() async {
    try {
      return await _app.engine.vaultExists();
    } catch (_) {
      return false;
    }
  }

  /// Asks again before export, share or delete: fingerprint if it is on, otherwise the password
  /// ([askPassword] shows the password box; null or empty = cancelled).
  Future<bool> confirm(String reason, {Future<String?> Function()? askPassword}) async {
    var ok = false;
    if (await fingerprintOn()) {
      try {
        ok = await _authenticate(reason);
      } on VaultProblem {
        ok = false;
      }
    }
    if (!ok && askPassword != null) {
      final password = await askPassword();
      if (password == null || password.isEmpty) return false;
      ok = await checkPassword(password);
      if (!ok) throw VaultProblem(wrongPassword);
    }
    if (ok) touch();
    return ok;
  }

  /// What the vault needs: `open`, `setup` (no vault yet) or `locked` (password or fingerprint).
  Future<String> state() async {
    if (isOpen) return 'open';
    if (await fingerprintOn()) return 'locked';
    final saved = await _savedRecord();
    final rec = saved ?? await _app.api.vaultRecovery();
    if (rec == null) return 'setup';
    // A vault from before passwords (12-word phrase) with nothing in it: just set a password.
    if (rec.kdf['secret'] != 'password' && await canStartOver().catchError((_) => false)) return 'setup';
    if (saved == null) await _saveRecord(rec);
    return 'locked';
  }

  /// Opens the vault with the fingerprint (only if it was turned on on this phone).
  Future<bool> unlockWithFingerprint() async {
    if (!await _authenticate('Open Mere Saboot')) return false;
    try {
      final key = await _app.engine.vaultUnlock();
      if (key == null) throw VaultProblem('Fingerprint is not set up on this phone. Use your password.');
      _opened(key, byFingerprint: true);
      return true;
    } on PlatformException catch (e) {
      if (e.code == 'auth_needed') throw VaultProblem(_authAgain);
      rethrow;
    }
  }

  /// Opens the vault with the password (also on a new phone: the locked key comes from the server).
  Future<void> unlockWithPassword(String password) async {
    var rec = await _record();
    var kek = await _kek(password, rec.kdf);
    if (await _check(kek) != rec.checkValue) {
      // The password may have been changed on another phone: try the server's copy once.
      final server = await _app.api.vaultRecovery().catchError((_) => null);
      if (server == null || server.checkValue == rec.checkValue) throw VaultProblem(wrongPassword);
      await _saveRecord(server);
      rec = server;
      kek = await _kek(password, rec.kdf);
      if (await _check(kek) != rec.checkValue) throw VaultProblem(wrongPassword);
    }
    _opened(base64Encode(await _app.engine.vaultDecrypt(base64Encode(kek), rec.lockedKey)));
  }

  /// Older name, kept for screens that open the vault without asking (fingerprint only).
  Future<bool> unlock() => unlockWithFingerprint();

  /// Opened with the fingerprint this time: a new password can be set without the old one (the
  /// fingerprint already proved it is the owner, and the vault key is in hand).
  bool openedWithFingerprint = false;

  void _opened(String key, {bool byFingerprint = false}) {
    _key = key;
    openedWithFingerprint = byFingerprint;
    _lastUsed = DateTime.now();
    notifyListeners();
    unawaited(retryUploads());
  }

  static const wrongPassword = 'Wrong password. Try again.';
  static const _authAgain = 'Please unlock with your fingerprint and try again.';

  /// True if [password] is this vault's password.
  Future<bool> checkPassword(String password) async {
    final rec = await _record();
    return await _check(await _kek(password, rec.kdf)) == rec.checkValue;
  }

  // The password-locked vault key, kept on this phone too, so the password also works offline.
  String get _recordKey => 'vault_record_${_app.me?.id ?? 'none'}';

  Future<VaultKeyRecord?> _savedRecord() async {
    try {
      final s = (await SharedPreferences.getInstance()).getString(_recordKey);
      if (s == null) return null;
      final j = jsonDecode(s) as Map<String, dynamic>;
      return VaultKeyRecord(j['lockedKey'] as String, j['kdf'] as Map<String, dynamic>, j['checkValue'] as String);
    } catch (_) {
      return null;
    }
  }

  Future<void> _saveRecord(VaultKeyRecord r) async {
    try {
      await (await SharedPreferences.getInstance())
          .setString(_recordKey, jsonEncode({'lockedKey': r.lockedKey, 'kdf': r.kdf, 'checkValue': r.checkValue}));
    } catch (_) {}
  }

  Future<VaultKeyRecord> _record() async {
    final saved = await _savedRecord();
    if (saved != null) return saved;
    final server = await _app.api.vaultRecovery();
    if (server == null) throw VaultProblem('No vault was found for your account.');
    await _saveRecord(server);
    return server;
  }

  /// Keeps the vault key on this phone for fingerprint opening (needs the unlock just done).
  Future<void> _storeKey(String key) async {
    try {
      await _app.engine.vaultStore(key);
    } on PlatformException catch (e) {
      if (e.code == 'auth_needed') throw VaultProblem(_authAgain);
      rethrow;
    }
  }

  /// Turns fingerprint opening on (vault open) or off. False if the fingerprint was cancelled.
  Future<bool> setFingerprint(bool on) async {
    if (!on) {
      await _app.engine.vaultForget();
      notifyListeners();
      return true;
    }
    final key = _need();
    if (!await _authenticate('Open Mere Saboot with your fingerprint')) return false;
    await _storeKey(key);
    notifyListeners();
    return true;
  }

  /// The secret Argon2id is run on. Vaults made with the old 12-word phrase ("secret" missing)
  /// keep their old rule, so that phrase still opens them when typed as the password.
  static List<int> _secret(String password, Map<String, dynamic> kdf) =>
      utf8.encode(kdf['secret'] == 'password' ? password : normalisePhrase(password));

  /// Lower case, one space between words (old 12-word phrase vaults only).
  static String normalisePhrase(String phrase) =>
      phrase.toLowerCase().split(RegExp(r'[^a-z]+')).where((w) => w.isNotEmpty).join(' ');

  Future<List<int>> _kek(String password, Map<String, dynamic> kdf) async {
    final algorithm = Argon2id(
      memory: (kdf['memoryKiB'] as num).toInt(),
      iterations: (kdf['iterations'] as num).toInt(),
      parallelism: (kdf['parallelism'] as num).toInt(),
      hashLength: 32,
    );
    final key = await algorithm.deriveKey(
      secretKey: SecretKey(_secret(password, kdf)),
      nonce: base64Decode(kdf['salt'] as String),
    );
    return key.extractBytes();
  }

  Future<String> _check(List<int> kek) async => _app.engine.sha256([...kek, ...utf8.encode('sarthi-vault-check-v1')]);

  /// Locks [key] with [password] and sends that copy to the server (and keeps it on this phone).
  Future<void> _lockWithPassword(String key, String password) async {
    final salt = List<int>.generate(16, (_) => Random.secure().nextInt(256));
    final kdf = {'name': 'argon2id', 'secret': 'password', 'salt': base64Encode(salt), ..._kdf};
    final kek = await _kek(password, kdf);
    final locked = await _app.engine.vaultEncrypt(base64Encode(kek), base64Decode(key));
    final check = await _check(kek);
    await _app.api.vaultSetup(locked, kdf, check);
    await _saveRecord(VaultKeyRecord(locked, kdf, check));
  }

  /// First use (or a fresh start): makes the vault key and locks it with [password]. With
  /// [fingerprint], the key is also kept on this phone for fingerprint opening (skipped if the
  /// phone has no fingerprint / screen lock or the prompt is cancelled).
  Future<void> setup(String password, {bool fingerprint = false}) async {
    if (password.isEmpty) throw VaultProblem('Enter a password.');
    final key = await _app.engine.vaultNewKey();
    await _lockWithPassword(key, password);
    await _app.engine.vaultForget().catchError((_) {}); // an old vault's fingerprint key
    if (fingerprint) {
      try {
        if (await _authenticate('Open Mere Saboot with your fingerprint')) await _storeKey(key);
      } on VaultProblem {
        // No fingerprint on this phone: the password alone opens the vault.
      }
    }
    _opened(key);
  }

  /// A new password for the open vault (the vault key and the evidence stay the same).
  /// [current] may be null only when the vault was opened with the fingerprint (forgotten password,
  /// evidence kept).
  Future<void> changePassword(String? current, String password) async {
    final key = _need();
    if (password.isEmpty) throw VaultProblem('Enter a new password.');
    if (current == null) {
      if (!openedWithFingerprint) throw VaultProblem('Enter your current password.');
    } else if (!await checkPassword(current)) {
      throw VaultProblem('Your current password is wrong.');
    }
    await _lockWithPassword(key, password);
  }

  /// The vault has nothing in it (a fresh start then loses nothing).
  Future<bool> canStartOver() async {
    final usage = await _app.api.vaultUsage();
    return usage.items == 0 && (await pending()).isEmpty;
  }

  /// "Forgot password" → Reset: the old evidence can never be opened without the old password, so
  /// it is deleted (protected items stay hidden on the server until their protection ends). Also
  /// clears this phone: the saved locked key, the fingerprint key and files not uploaded yet
  /// (encrypted with the old key). Afterwards the user sets a new password ([setup]).
  Future<({int deleted, int keptLocked, DateTime? lockedUntil})> reset() async {
    final result = await _app.api.vaultReset();
    try {
      await (await SharedPreferences.getInstance()).remove(_recordKey);
    } catch (_) {}
    await _app.engine.vaultForget().catchError((_) {});
    try {
      final dir = await _pendingDir();
      if (dir.existsSync()) dir.deleteSync(recursive: true);
    } catch (_) {}
    lock(); // the server already wrote "reset" in the access history
    return result;
  }

  String _need() {
    final k = _key;
    if (k == null) throw VaultProblem('The vault is locked.');
    touch();
    return k;
  }

  // ---- Encryption helpers ------------------------------------------------------------------------

  Future<String> lockJson(Map<String, Object?> json) async => _app.engine.vaultEncrypt(_need(), utf8.encode(jsonEncode(json)));

  Future<Map<String, dynamic>> unlockJson(String locked) async =>
      jsonDecode(utf8.decode(await _app.engine.vaultDecrypt(_need(), locked))) as Map<String, dynamic>;

  Future<ItemDetails> details(EvidenceItem item) async {
    final cached = _detailsCache[item.id];
    if (cached != null) return cached;
    final d = ItemDetails.fromJson(await unlockJson(item.lockedDetails));
    _detailsCache[item.id] = d;
    return d;
  }

  Future<IncidentDetails> incidentDetails(Incident i) async => IncidentDetails.fromJson(await unlockJson(i.lockedDetails));

  // ---- Adding evidence ---------------------------------------------------------------------------

  Future<Directory> _pendingDir() async {
    // One folder per account: another account logged in on this phone never uploads these.
    final dir = Directory('${(await getApplicationSupportDirectory()).path}/vault_pending/${_app.me?.id ?? 'none'}');
    if (!dir.existsSync()) dir.createSync(recursive: true);
    return dir;
  }

  /// Encrypts a file on the phone and returns at once (the item id); the upload runs in the
  /// background. Until it is uploaded the item stays encrypted on the phone ("Waiting to upload")
  /// and is tried again later. Saving never waits for the internet.
  Future<String> addFile({
    required String path,
    required String kind,
    required ItemDetails details,
    String? incidentId,
    String? sosId,
    DateTime? capturedAt,
    bool deleteSource = false,
  }) async {
    final key = _need();
    final id = _uuid.v4();
    final fileKey = await _app.engine.vaultNewKey();
    final out = File('${(await _pendingDir()).path}/$id.enc');
    final enc = await _app.engine.vaultEncryptFile(path, out.path, fileKey);
    if (deleteSource) {
      try {
        await File(path).delete();
      } catch (_) {}
    }
    final body = {
      'id': id,
      'kind': kind,
      'incidentId': incidentId,
      'lockedFileKey': await _app.engine.vaultEncrypt(key, base64Decode(fileKey)),
      'lockedDetails': await lockJson(details.toJson()),
      'sha256': enc.sha256,
      'capturedAt': (capturedAt ?? DateTime.now()).toUtc().toIso8601String(),
      'sizeBytes': enc.size,
      'sosId': ?sosId,
    };
    await File('${(await _pendingDir()).path}/$id.json').writeAsString(jsonEncode(body));
    notifyListeners();
    unawaited(_upload(id));
    return id;
  }

  /// A typed detail (number, email, link, profile): only an encrypted record, no file.
  Future<void> addDetail({required String type, required String value, String note = '', String? incidentId}) async {
    final key = _need();
    final fileKey = await _app.engine.vaultNewKey();
    await _app.api.saveEvidence({
      'id': _uuid.v4(),
      'kind': 'detail',
      'incidentId': incidentId,
      'lockedFileKey': await _app.engine.vaultEncrypt(key, base64Decode(fileKey)),
      'lockedDetails': await lockJson(ItemDetails(note: note, detailType: type, value: value).toJson()),
      'sha256': await _app.engine.sha256(utf8.encode('$type:$value')),
      'capturedAt': DateTime.now().toUtc().toIso8601String(),
      'sizeBytes': 0,
    });
    notifyListeners();
  }

  /// Items being uploaded right now (never the same one twice at a time).
  final Set<String> _uploading = {};

  bool isUploading(String id) => _uploading.contains(id);

  /// Why the last upload was refused for good (e.g. storage full), shown on the vault screen.
  String? uploadProblem;

  /// Why the last try for one waiting item failed (shown under it), so a stuck upload is never silent.
  final Map<String, String> uploadErrors = {};

  /// A waiting item as the vault list shows it, so it can be opened from its encrypted copy on this phone.
  Future<EvidenceItem?> pendingItem(String id) async {
    final meta = File('${(await _pendingDir()).path}/$id.json');
    if (!meta.existsSync()) return null;
    final j = jsonDecode(await meta.readAsString()) as Map<String, dynamic>;
    final now = DateTime.now().toUtc().toIso8601String();
    return EvidenceItem.fromJson({...j, 'receivedAt': now, 'hasFile': true, 'hidden': false, 'deleteLockedUntil': now});
  }

  Future<void> _upload(String id) async {
    if (!_uploading.add(id)) return;
    try {
      final dir = await _pendingDir();
      final meta = File('${dir.path}/$id.json');
      final enc = File('${dir.path}/$id.enc');
      if (!meta.existsSync() || !enc.existsSync()) return;
      final body = jsonDecode(await meta.readAsString()) as Map<String, dynamic>;
      final link = await _app.api.evidenceUploadLink(id, enc.lengthSync());
      await _app.api.uploadFile(link, enc.path);
      await _app.api.saveEvidence(body);
      meta.deleteSync();
      enc.deleteSync();
      uploadProblem = null;
      uploadErrors.remove(id);
    } on ApiException catch (e) {
      // Refused (e.g. storage full): say why; the file stays encrypted here for a later retry.
      uploadErrors[id] = e.message;
      if (e.code == 'limit_reached' || e.status == 400 || e.status == 409) uploadProblem = e.message;
    } catch (e) {
      // Offline, slow network or file storage not answering: tried again later, and the reason is kept.
      uploadErrors[id] = 'Could not reach the file storage. Will try again.';
    } finally {
      _uploading.remove(id);
      notifyListeners();
    }
  }

  /// The encrypted file of an item still waiting on this phone (null once uploaded).
  Future<File?> _pendingFile(String id) async {
    final f = File('${(await _pendingDir()).path}/$id.enc');
    return f.existsSync() ? f : null;
  }

  /// Files encrypted on this phone and not uploaded yet.
  Future<List<PendingUpload>> pending() async {
    final dir = await _pendingDir();
    final list = <PendingUpload>[];
    // A small folder: a plain listing is enough.
    for (final f in dir.listSync()) {
      if (!f.path.endsWith('.json')) continue;
      try {
        final j = jsonDecode(await File(f.path).readAsString()) as Map<String, dynamic>;
        list.add(PendingUpload(j['id'] as String, j['kind'] as String, DateTime.parse(j['capturedAt'] as String).toLocal()));
      } catch (_) {}
    }
    return list;
  }

  Future<void> retryUploads() async {
    try {
      for (final p in await pending()) {
        await _upload(p.id);
      }
    } catch (_) {
      // Tried again next time the vault opens.
    }
  }

  // ---- Opening, exporting ------------------------------------------------------------------------

  /// Downloads and decrypts a file into the private cache (deleted when the vault locks).
  Future<String> openFile(EvidenceItem item) async {
    final key = _need();
    final d = await details(item);
    final dir = Directory('${(await getTemporaryDirectory()).path}/vault');
    if (!dir.existsSync()) dir.createSync(recursive: true);
    final ext = (d.fileName ?? '').contains('.') ? d.fileName!.split('.').last : _ext(item.kind, d.mime);
    final out = File('${dir.path}/${item.id}.$ext');
    if (out.existsSync()) return out.path;
    final fileKey = base64Encode(await _app.engine.vaultDecrypt(key, item.lockedFileKey));
    // Decrypted into a temporary name first, so a failed or interrupted open never leaves a
    // half-written file that would be shown next time.
    final part = File('${out.path}.part');
    final local = await _pendingFile(item.id);
    final enc = File('${dir.path}/${item.id}.enc');
    try {
      if (local != null) {
        // Not uploaded yet: open the encrypted copy on this phone (no download).
        await _app.engine.vaultDecryptFile(local.path, part.path, fileKey);
      } else {
        await _app.api.downloadFile(await _app.api.evidenceDownloadUrl(item.id), enc.path);
        await _app.engine.vaultDecryptFile(enc.path, part.path, fileKey);
      }
      part.renameSync(out.path);
    } finally {
      if (enc.existsSync()) enc.deleteSync();
      if (part.existsSync()) part.deleteSync();
    }
    unawaited(log('viewed', itemId: item.id, incidentId: item.incidentId));
    return out.path;
  }

  static String _ext(String kind, String? mime) => switch (kind) {
        'audio' => 'm4a',
        'video' => 'mp4',
        'photo' => 'jpg',
        'report' => 'pdf',
        _ => (mime ?? '').contains('pdf') ? 'pdf' : 'bin',
      };

  static String mimeOf(String kind, ItemDetails d) =>
      d.mime ??
      switch (kind) {
        'audio' => 'audio/mp4',
        'video' => 'video/mp4',
        'photo' => 'image/jpeg',
        'report' => 'application/pdf',
        _ => 'application/octet-stream',
      };

  Future<void> log(String action, {String? itemId, String? incidentId}) async {
    try {
      final info = await _app.engine.deviceInfo();
      await _app.api.addAccessLog([
        {'action': action, 'itemId': itemId, 'incidentId': incidentId, 'at': DateTime.now().toUtc().toIso8601String()},
      ], device: '${info['manufacturer'] ?? ''} ${info['model'] ?? ''}'.trim());
    } catch (_) {}
  }
}

