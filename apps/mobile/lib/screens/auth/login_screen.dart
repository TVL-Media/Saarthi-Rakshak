import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../api/api_client.dart';
import '../../state/app_state.dart';
import '../../theme.dart';
import '../../widgets/common.dart';
import '../../widgets/format.dart';
import 'phone_otp.dart';

/// Phone number + OTP (design: "Create Account" card; Phase 1 logs in with the phone only).
class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key});

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final _phone = TextEditingController();
  final _code = TextEditingController();
  PhoneOtp? _otp;
  String? _e164;
  String? _error;
  int _resends = 0;
  int _wait = 0;
  Timer? _timer;

  @override
  void dispose() {
    _timer?.cancel();
    _phone.dispose();
    _code.dispose();
    super.dispose();
  }

  void _startWait(int seconds) {
    _timer?.cancel();
    setState(() => _wait = seconds);
    _timer = Timer.periodic(const Duration(seconds: 1), (t) {
      if (!mounted) return t.cancel();
      setState(() => _wait--);
      if (_wait <= 0) t.cancel();
    });
  }

  Future<void> _send() async {
    final e164 = normaliseIndianMobile(_phone.text);
    if (e164 == null) {
      setState(() => _error = 'Enter a 10-digit Indian mobile number.');
      return;
    }
    if (!firebaseReady) {
      setState(() => _error = 'Login is not set up in this build of the app (Firebase settings missing).');
      return;
    }
    setState(() => _error = null);
    _otp ??= PhoneOtp();
    try {
      final instant = await _otp!.send(e164);
      if (instant != null) return await _finish(instant);
      setState(() => _e164 = e164);
      // Resend after 30 s; after 3 resends wait 15 minutes (plan 7.4).
      _startWait(_resends >= 3 ? 15 * 60 : 30);
    } on OtpError catch (e) {
      setState(() => _error = e.message);
    }
  }

  Future<void> _verify() async {
    if (_code.text.trim().length != 6) {
      setState(() => _error = 'Enter the 6-digit OTP.');
      return;
    }
    try {
      await _finish(await _otp!.verify(_code.text.trim()));
    } on OtpError catch (e) {
      setState(() => _error = e.message);
    }
  }

  Future<void> _finish(String idToken) async {
    try {
      await AppScope.read(context).loginWithFirebaseToken(idToken);
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    }
  }

  @override
  Widget build(BuildContext context) {
    final codeStep = _e164 != null;
    return Scaffold(
      backgroundColor: AppColors.night,
      body: Container(
        decoration: const BoxDecoration(
          gradient: LinearGradient(
            begin: Alignment.topCenter,
            end: Alignment.bottomCenter,
            colors: [Color(0xFF1B1F27), Color(0xFF2A0B0D)],
          ),
        ),
        child: SafeArea(
          child: ListView(
            padding: const EdgeInsets.fromLTRB(16, 56, 16, 16),
            children: [
              Container(
                padding: const EdgeInsets.fromLTRB(20, 24, 20, 20),
                decoration: BoxDecoration(color: AppColors.cream, borderRadius: BorderRadius.circular(28)),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    if (codeStep)
                      Align(
                        alignment: Alignment.centerLeft,
                        child: IconButton(
                          icon: const Icon(Icons.chevron_left),
                          onPressed: () => setState(() {
                            _e164 = null;
                            _code.clear();
                            _error = null;
                          }),
                        ),
                      ),
                    Text(
                      codeStep ? 'Enter OTP' : 'Log in or sign up',
                      textAlign: TextAlign.center,
                      style: const TextStyle(fontSize: 28, fontWeight: FontWeight.w800),
                    ),
                    const SizedBox(height: 6),
                    Text(
                      codeStep ? 'We sent a 6-digit code to $_e164' : 'Let’s make your journey safer',
                      textAlign: TextAlign.center,
                      style: const TextStyle(fontSize: 16, color: AppColors.muted),
                    ),
                    const SizedBox(height: 24),
                    if (!codeStep)
                      TextField(
                        key: const Key('phone'),
                        controller: _phone,
                        keyboardType: TextInputType.phone,
                        autofillHints: const [AutofillHints.telephoneNumber],
                        inputFormatters: [FilteringTextInputFormatter.allow(RegExp(r'[0-9 +]')), LengthLimitingTextInputFormatter(16)],
                        decoration: const InputDecoration(
                          prefixIcon: Icon(Icons.phone_android_outlined),
                          prefixText: '+91  ',
                          hintText: 'Mobile number',
                        ),
                        onSubmitted: (_) => _send(),
                      )
                    else
                      TextField(
                        key: const Key('otp'),
                        controller: _code,
                        keyboardType: TextInputType.number,
                        autofillHints: const [AutofillHints.oneTimeCode],
                        textAlign: TextAlign.center,
                        style: const TextStyle(fontSize: 24, letterSpacing: 10, fontWeight: FontWeight.w700),
                        inputFormatters: [FilteringTextInputFormatter.digitsOnly, LengthLimitingTextInputFormatter(6)],
                        decoration: const InputDecoration(hintText: '••••••'),
                        onSubmitted: (_) => _verify(),
                      ),
                    if (_error != null) ...[
                      const SizedBox(height: 10),
                      Text(_error!, style: const TextStyle(color: AppColors.red, fontWeight: FontWeight.w500)),
                    ],
                    const SizedBox(height: 20),
                    BusyButton(label: codeStep ? 'Verify' : 'Send OTP', onPressed: codeStep ? _verify : _send),
                    if (codeStep) ...[
                      const SizedBox(height: 8),
                      TextButton(
                        onPressed: _wait > 0
                            ? null
                            : () {
                                _resends++;
                                _send();
                              },
                        child: Text(_wait > 0 ? 'Resend OTP in ${_wait ~/ 60 > 0 ? '${_wait ~/ 60} min' : '$_wait s'}' : 'Resend OTP'),
                      ),
                    ],
                  ],
                ),
              ),
              const SizedBox(height: 24),
              TextButton.icon(
                style: TextButton.styleFrom(foregroundColor: Colors.white),
                onPressed: () => launchUrl(Uri.parse('tel:112')),
                icon: const Icon(Icons.local_phone, color: AppColors.red),
                label: const Text('Emergency? Call 112'),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
