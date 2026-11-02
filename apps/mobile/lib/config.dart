/// Build-time settings, passed with --dart-define (see apps/mobile/README.md). Nothing secret here:
/// the Firebase values below are public app identifiers, not keys that grant access.
class AppConfig {
  /// The server. Debug default: the laptop through USB (`adb reverse tcp:3000 tcp:3000`).
  static const apiUrl = String.fromEnvironment('API_URL', defaultValue: 'http://localhost:3000');

  /// Firebase (phone OTP login, push). Empty = login is off and the app says so.
  static const firebaseApiKey = String.fromEnvironment('FIREBASE_API_KEY');
  static const firebaseAppId = String.fromEnvironment('FIREBASE_APP_ID');
  static const firebaseProjectId = String.fromEnvironment('FIREBASE_PROJECT_ID');
  static const firebaseSenderId = String.fromEnvironment('FIREBASE_SENDER_ID');

  static bool get firebaseConfigured =>
      firebaseApiKey.isNotEmpty && firebaseAppId.isNotEmpty && firebaseProjectId.isNotEmpty;

  /// Google Maps / Places key for destination search (the map key itself is in the Android build).
  static const mapsApiKey = String.fromEnvironment('MAPS_API_KEY');

  /// Terms version the user accepts (must match what the server expects to store).
  static const consentVersion = '2026-10';

  static const privacyUrl = String.fromEnvironment('PRIVACY_URL', defaultValue: 'https://sarthirakshak.in/privacy');
  static const termsUrl = String.fromEnvironment('TERMS_URL', defaultValue: 'https://sarthirakshak.in/terms');

  /// Shown wherever the app describes what it does (never present it as 24/7 monitoring).
  static const notMonitoring =
      'Sarthi Rakshak alerts your guardians and helps you call 112. It is not a 24/7 monitoring service.';
}
