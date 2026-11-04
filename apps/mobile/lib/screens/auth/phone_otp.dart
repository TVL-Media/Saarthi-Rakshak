import 'dart:async';

import 'package:firebase_auth/firebase_auth.dart';

/// Phone number check with Firebase (sends the OTP SMS, checks the code). Returns a Firebase ID
/// token that our server exchanges for its own session.
class PhoneOtp {
  PhoneOtp({FirebaseAuth? auth}) : _auth = auth ?? FirebaseAuth.instance;
  final FirebaseAuth _auth;

  String? _verificationId;
  int? _resendToken;

  /// Sends the OTP. Completes with null when the SMS was sent, or with an ID token straight away
  /// when Android read the SMS by itself.
  Future<String?> send(String e164) {
    final done = Completer<String?>();
    _auth.verifyPhoneNumber(
      phoneNumber: e164,
      forceResendingToken: _resendToken,
      timeout: const Duration(seconds: 60),
      verificationCompleted: (credential) async {
        if (done.isCompleted) return;
        try {
          done.complete(await _signIn(credential));
        } catch (e) {
          done.completeError(e);
        }
      },
      verificationFailed: (e) {
        if (!done.isCompleted) done.completeError(OtpError(_message(e.code)));
      },
      codeSent: (verificationId, resendToken) {
        _verificationId = verificationId;
        _resendToken = resendToken;
        if (!done.isCompleted) done.complete(null);
      },
      codeAutoRetrievalTimeout: (verificationId) => _verificationId = verificationId,
    );
    return done.future;
  }

  /// Checks the 6-digit code; returns the Firebase ID token.
  Future<String> verify(String code) async {
    final id = _verificationId;
    if (id == null) throw OtpError('Please ask for a new OTP.');
    try {
      return await _signIn(PhoneAuthProvider.credential(verificationId: id, smsCode: code));
    } on FirebaseAuthException catch (e) {
      throw OtpError(_message(e.code));
    }
  }

  Future<String> _signIn(PhoneAuthCredential credential) async {
    final result = await _auth.signInWithCredential(credential);
    final token = await result.user!.getIdToken(true);
    // Our server keeps the session; Firebase is only for the OTP check.
    await _auth.signOut();
    return token!;
  }

  static String _message(String code) => switch (code) {
        'invalid-phone-number' => 'This phone number is not valid.',
        'invalid-verification-code' => 'Wrong OTP. Please check and try again.',
        'session-expired' || 'code-expired' => 'The OTP has expired. Ask for a new one.',
        'too-many-requests' => 'Too many tries. Please wait 15 minutes and try again.',
        'network-request-failed' => 'No internet connection. Please try again.',
        'quota-exceeded' => 'OTP service is busy. Please try again later.',
        'operation-not-allowed' => 'Phone login is not turned on in Firebase (Authentication → Sign-in method → Phone).',
        'app-not-authorized' || 'missing-client-identifier' || 'invalid-app-credential' =>
          'This app is not allowed by Firebase yet. Add the SHA-1 and SHA-256 fingerprints to the Android app in Firebase. ($code)',
        'billing-not-enabled' => 'Real SMS needs billing in Firebase. Use a Firebase test phone number instead. ($code)',
        _ => 'Could not verify your number. Please try again. ($code)',
      };
}

class OtpError implements Exception {
  OtpError(this.message);
  final String message;
  @override
  String toString() => message;
}
