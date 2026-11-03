import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../api/api_client.dart';
import '../../config.dart';
import '../../state/app_state.dart';
import '../../theme.dart';
import '../../widgets/common.dart';
import '../../widgets/format.dart';
import 'phone_otp.dart';
import 'profile_screen.dart';

/// Login and Sign up with phone number + OTP (design frame 3 "Create Account").
/// Phase 1 uses the phone only: no email, password, Google or Apple.
class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key, this.signUp = false});

  /// Open on the Sign up page instead of Login.
  final bool signUp;

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

/// Builds made with DEV_LOGIN=true (debug or the closed-test APK): no Firebase SMS, the code is
/// checked by our server.
bool get _testLogin => AppConfig.devLogin;

class _LoginScreenState extends State<LoginScreen> {
  late bool _signUp = widget.signUp;
  final _name = TextEditingController();
  bool _agreed = false;
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
    _name.dispose();
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
    if (_signUp) {
      final problem = checkProfileName(_name.text);
      if (problem != null) {
        setState(() => _error = problem);
        return;
      }
      if (!_agreed) {
        setState(() => _error = 'Please agree to the Terms & Conditions.');
        return;
      }
    }
    final e164 = normaliseIndianMobile(_phone.text);
    if (e164 == null) {
      setState(() => _error = 'Enter a 10-digit Indian mobile number.');
      return;
    }
    if (_testLogin) {
      setState(() {
        _error = null;
        _e164 = e164;
      });
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
    if (_testLogin) {
      try {
        await AppScope.read(context).loginWithDevCode(_e164!, _code.text.trim(), signUpName: _signUpName);
      } on ApiException catch (e) {
        if (mounted) setState(() => _error = e.message);
      }
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
      await AppScope.read(context).loginWithFirebaseToken(idToken, signUpName: _signUpName);
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    }
  }

  String? get _signUpName => _signUp ? _name.text.trim() : null;

  void _switchMode() => setState(() {
    _signUp = !_signUp;
    _error = null;
  });

  void _backToNumber() => setState(() {
    _e164 = null;
    _code.clear();
    _error = null;
  });

  @override
  Widget build(BuildContext context) {
    final codeStep = _e164 != null;
    final title = codeStep ? 'Enter OTP' : (_signUp ? 'Create Account' : 'Welcome Back');
    final subtitle = codeStep
        ? (_testLogin ? 'Enter the test OTP for $_e164' : 'We sent a 6-digit code to $_e164')
        : (_signUp ? 'Let’s make your journey safer' : 'Log in to keep your journeys safe');
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
          bottom: false,
          child: LayoutBuilder(
            builder: (context, box) => SingleChildScrollView(
              child: ConstrainedBox(
                constraints: BoxConstraints(minHeight: box.maxHeight),
                child: IntrinsicHeight(
                  child: Column(
                    children: [
                      const SizedBox(height: 140),
                      Expanded(
                        child: Container(
                          width: double.infinity,
                          margin: EdgeInsets.fromLTRB(6, 0, 6, 6 + MediaQuery.of(context).padding.bottom),
                          padding: const EdgeInsets.fromLTRB(20, 12, 20, 16),
                          decoration: BoxDecoration(color: AppColors.cream, borderRadius: BorderRadius.circular(28)),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.stretch,
                            children: [
                              SizedBox(
                                height: 40,
                                child: Align(
                                  alignment: Alignment.centerLeft,
                                  child: (codeStep || _signUp)
                                      ? IconButton(
                                          key: const Key('back'),
                                          icon: const Icon(Icons.chevron_left, size: 28),
                                          onPressed: codeStep ? _backToNumber : _switchMode,
                                        )
                                      : null,
                                ),
                              ),
                              Text(
                                title,
                                textAlign: TextAlign.center,
                                style: const TextStyle(fontSize: 26, fontWeight: FontWeight.w800),
                              ),
                              const SizedBox(height: 4),
                              Text(
                                subtitle,
                                textAlign: TextAlign.center,
                                style: const TextStyle(fontSize: 16, color: AppColors.ink),
                              ),
                              if (_testLogin) ...[
                                const SizedBox(height: 10),
                                Container(
                                  padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
                                  decoration: BoxDecoration(
                                    color: AppColors.amberSoft,
                                    borderRadius: BorderRadius.circular(10),
                                  ),
                                  child: const Text(
                                    'Test mode (development only): any mobile number works with the test OTP from the server',
                                    textAlign: TextAlign.center,
                                    style: TextStyle(color: AppColors.amber, fontWeight: FontWeight.w600),
                                  ),
                                ),
                              ],
                              const SizedBox(height: 22),
                              if (!codeStep) ...[
                                if (_signUp) ...[
                                  TextField(
                                    key: const Key('name'),
                                    controller: _name,
                                    textCapitalization: TextCapitalization.words,
                                    autofillHints: const [AutofillHints.name],
                                    decoration: const InputDecoration(
                                      prefixIcon: Icon(Icons.person_outline),
                                      hintText: 'Full Name',
                                    ),
                                  ),
                                  const SizedBox(height: 12),
                                ],
                                TextField(
                                  key: const Key('phone'),
                                  controller: _phone,
                                  keyboardType: TextInputType.phone,
                                  autofillHints: const [AutofillHints.telephoneNumber],
                                  inputFormatters: [
                                    FilteringTextInputFormatter.allow(RegExp(r'[0-9 +]')),
                                    LengthLimitingTextInputFormatter(16),
                                  ],
                                  decoration: const InputDecoration(
                                    prefixIcon: Row(
                                      mainAxisSize: MainAxisSize.min,
                                      children: [
                                        SizedBox(width: 14),
                                        Icon(Icons.phone_android_outlined),
                                        SizedBox(width: 10),
                                        Text('+91', style: TextStyle(fontWeight: FontWeight.w600, fontSize: 16)),
                                        SizedBox(width: 10),
                                        SizedBox(height: 22, child: VerticalDivider(width: 1, color: AppColors.line)),
                                        SizedBox(width: 12),
                                      ],
                                    ),
                                    hintText: 'Mobile Number',
                                  ),
                                  onSubmitted: (_) => _send(),
                                ),
                                if (_signUp) ...[
                                  const SizedBox(height: 10),
                                  Row(
                                    children: [
                                      SizedBox(
                                        width: 32,
                                        child: Checkbox(
                                          key: const Key('terms'),
                                          value: _agreed,
                                          activeColor: AppColors.red,
                                          onChanged: (v) => setState(() => _agreed = v ?? false),
                                        ),
                                      ),
                                      const SizedBox(width: 6),
                                      const Text('I agree to ', style: TextStyle(fontSize: 15)),
                                      GestureDetector(
                                        onTap: () => launchUrl(Uri.parse(AppConfig.termsUrl)),
                                        child: const Text(
                                          'Terms & Conditions',
                                          style: TextStyle(
                                            fontSize: 15,
                                            color: AppColors.red,
                                            fontWeight: FontWeight.w500,
                                          ),
                                        ),
                                      ),
                                    ],
                                  ),
                                ],
                              ] else
                                TextField(
                                  key: const Key('otp'),
                                  controller: _code,
                                  keyboardType: TextInputType.number,
                                  autofillHints: const [AutofillHints.oneTimeCode],
                                  textAlign: TextAlign.center,
                                  style: const TextStyle(fontSize: 24, letterSpacing: 10, fontWeight: FontWeight.w700),
                                  inputFormatters: [
                                    FilteringTextInputFormatter.digitsOnly,
                                    LengthLimitingTextInputFormatter(6),
                                  ],
                                  decoration: const InputDecoration(hintText: '••••••'),
                                  onSubmitted: (_) => _verify(),
                                ),
                              if (_error != null) ...[
                                const SizedBox(height: 10),
                                Text(
                                  _error!,
                                  style: const TextStyle(color: AppColors.red, fontWeight: FontWeight.w500),
                                ),
                              ],
                              const SizedBox(height: 18),
                              BusyButton(
                                label: codeStep ? 'Verify' : (_signUp ? 'Sign Up' : 'Send OTP'),
                                onPressed: codeStep ? _verify : _send,
                              ),
                              if (codeStep) ...[
                                const SizedBox(height: 8),
                                TextButton(
                                  onPressed: _wait > 0
                                      ? null
                                      : () {
                                          _resends++;
                                          _send();
                                        },
                                  child: Text(
                                    _wait > 0
                                        ? 'Resend OTP in ${_wait ~/ 60 > 0 ? '${_wait ~/ 60} min' : '$_wait s'}'
                                        : 'Resend OTP',
                                  ),
                                ),
                              ] else ...[
                                const Spacer(),
                                const SizedBox(height: 18),
                                Row(
                                  mainAxisAlignment: MainAxisAlignment.center,
                                  children: [
                                    Text(
                                      _signUp ? 'Already have an account? ' : 'Don’t have an account? ',
                                      style: const TextStyle(fontSize: 15),
                                    ),
                                    GestureDetector(
                                      key: const Key('switch-mode'),
                                      onTap: _switchMode,
                                      child: Text(
                                        _signUp ? 'Login' : 'Sign Up',
                                        style: const TextStyle(
                                          fontSize: 15,
                                          color: AppColors.red,
                                          fontWeight: FontWeight.w700,
                                        ),
                                      ),
                                    ),
                                  ],
                                ),
                              ],
                              const SizedBox(height: 8),
                              TextButton.icon(
                                onPressed: () => launchUrl(Uri.parse('tel:112')),
                                icon: const Icon(Icons.local_phone, color: AppColors.red),
                                label: const Text('Emergency? Call 112'),
                              ),
                            ],
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
