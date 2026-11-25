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

  /// Test builds only (built with DEV_LOGIN=true, e.g. the closed-test APK): log in with the
  /// server's test code (DEV_LOGIN_* on the server) instead of a Firebase SMS. Never set it for a
  /// Play Store build; the server also refuses the test login when NODE_ENV is production.
  static const devLogin = bool.fromEnvironment('DEV_LOGIN');

  /// Phase 3 (Rakshaks near me, bookings): shown in the menu for every build made with PHASE3=true
  /// (test builds). Otherwise each feature appears only when the server switches it on for the user
  /// (rule `feature.nearby` / `feature.bookings` set to 1).
  static const phase3 = bool.fromEnvironment('PHASE3');

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
