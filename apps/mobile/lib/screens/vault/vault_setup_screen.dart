import 'package:flutter/material.dart';

import '../../api/api_client.dart';
import '../../state/app_state.dart';
import '../../state/vault_session.dart';
import '../../theme.dart';
import '../../widgets/common.dart';
import 'vault_screen.dart';

/// A password box with a show / hide eye.
class PasswordField extends StatefulWidget {
  const PasswordField({super.key, required this.controller, required this.label, this.onSubmitted, this.autofocus = false});
  final TextEditingController controller;
  final String label;
  final ValueChanged<String>? onSubmitted;
  final bool autofocus;

  @override
  State<PasswordField> createState() => _PasswordFieldState();
}

class _PasswordFieldState extends State<PasswordField> {
  bool _show = false;

  @override
  Widget build(BuildContext context) => TextField(
        controller: widget.controller,
        obscureText: !_show,
        autocorrect: false,
        enableSuggestions: false,
        autofocus: widget.autofocus,
        onSubmitted: widget.onSubmitted,
        decoration: InputDecoration(
          labelText: widget.label,
          prefixIcon: const Icon(Icons.lock_outline),
          suffixIcon: IconButton(
            tooltip: _show ? 'Hide password' : 'Show password',
            icon: Icon(_show ? Icons.visibility_off_outlined : Icons.visibility_outlined),
            onPressed: () => setState(() => _show = !_show),
          ),
        ),
      );
}

/// Asks for the Mere Saboot password (e.g. before sharing evidence). Null if cancelled.
Future<String?> askVaultPassword(BuildContext context, {String title = 'Enter your Mere Saboot password'}) {
  final c = TextEditingController();
  return showDialog<String>(
    context: context,
    builder: (d) => AlertDialog(
      title: Text(title),
      content: PasswordField(controller: c, label: 'Password', autofocus: true, onSubmitted: (v) => Navigator.pop(d, v)),
      actions: [
        TextButton(onPressed: () => Navigator.pop(d), child: const Text('Cancel')),
        FilledButton(onPressed: () => Navigator.pop(d, c.text), child: const Text('OK')),
      ],
    ),
  ).whenComplete(c.dispose);
}

/// Asks again before export, share or delete: fingerprint if it is on, else the password.
Future<bool> confirmVault(BuildContext context, String reason) =>
    AppScope.read(context).vault.confirm(reason, askPassword: () => askVaultPassword(context));

/// First use (or a fresh start after a forgotten password on an empty vault): set a password.
class VaultSetupView extends StatefulWidget {
  const VaultSetupView({super.key, required this.onDone, this.startOver = false});
  final Future<void> Function() onDone;

  /// Replaces a vault with no evidence whose password was forgotten.
  final bool startOver;

  @override
  State<VaultSetupView> createState() => _VaultSetupViewState();
}

class _VaultSetupViewState extends State<VaultSetupView> {
  late final VaultSession _vault = AppScope.read(context).vault;
  final _password = TextEditingController();
  final _again = TextEditingController();
  bool _fingerprint = true;
  String? _error;

  @override
  void dispose() {
    _password.dispose();
    _again.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    if (_password.text.isEmpty) {
      setState(() => _error = 'Enter a password.');
      return;
    }
    if (_password.text != _again.text) {
      setState(() => _error = 'The two passwords are not the same.');
      return;
    }
    setState(() => _error = null);
    try {
      await _vault.setup(_password.text, fingerprint: _fingerprint);
      await widget.onDone();
    } on VaultProblem catch (e) {
      if (mounted) setState(() => _error = e.message);
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } catch (e) {
      if (mounted) setState(() => _error = 'Could not set up the vault. Please try again.');
    }
  }

  @override
  Widget build(BuildContext context) => ListView(padding: const EdgeInsets.fromLTRB(20, 16, 20, 32), children: [
        const VaultHero(),
        const SizedBox(height: 20),
        ScreenTitle(widget.startOver ? 'Start a new vault' : 'Set a password',
            subtitle: 'You will enter it every time you open Mere Saboot.'),
        const SizedBox(height: 16),
        PasswordField(controller: _password, label: 'Password'),
        const SizedBox(height: 12),
        PasswordField(controller: _again, label: 'Type it again', onSubmitted: (_) => _save()),
        const SizedBox(height: 8),
        SwitchListTile(
          key: const Key('setup-fingerprint'),
          contentPadding: EdgeInsets.zero,
          value: _fingerprint,
          onChanged: (v) => setState(() => _fingerprint = v),
          title: const Text('Also open with fingerprint', style: TextStyle(fontWeight: FontWeight.w600)),
          subtitle: const Text('On this phone. The password always works too.'),
        ),
        if (_error != null) Padding(padding: const EdgeInsets.only(bottom: 12), child: Text(_error!, key: const Key('vault-error'), style: const TextStyle(color: AppColors.red))),
        const SizedBox(height: 8),
        BusyButton(label: widget.startOver ? 'Start new vault' : 'Set password', onPressed: _save),
        const SizedBox(height: 14),
        const NoticeBox(
          text: 'Remember this password. If you forget it, nobody can open your evidence, not even Sarthi Rakshak. '
              'A longer password is harder for others to guess.',
        ),
      ]);
}

/// The vault is locked: password, or fingerprint if it is on for this phone.
class VaultUnlockView extends StatefulWidget {
  const VaultUnlockView({super.key, required this.onOpened, required this.onStartOver, this.autoFingerprint = true});
  final Future<void> Function() onOpened;

  /// Shows the fingerprint prompt at once (if fingerprint opening is on).
  final bool autoFingerprint;

  /// "Forgot password" on a vault with no evidence: set up a new one.
  final VoidCallback onStartOver;

  @override
  State<VaultUnlockView> createState() => _VaultUnlockViewState();
}

class _VaultUnlockViewState extends State<VaultUnlockView> {
  late final VaultSession _vault = AppScope.read(context).vault;
  final _password = TextEditingController();
  bool _fingerprint = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _vault.fingerprintOn().then((on) {
      if (!mounted) return;
      setState(() => _fingerprint = on);
      if (on && widget.autoFingerprint) _useFingerprint(); // offered straight away, like before
    });
  }

  @override
  void dispose() {
    _password.dispose();
    super.dispose();
  }

  Future<void> _open() async {
    if (_password.text.isEmpty) {
      setState(() => _error = 'Enter your password.');
      return;
    }
    setState(() => _error = null);
    try {
      await _vault.unlockWithPassword(_password.text);
      await widget.onOpened();
    } on VaultProblem catch (e) {
      if (mounted) setState(() => _error = e.message);
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } catch (_) {
      if (mounted) setState(() => _error = 'Could not open the vault. Please try again.');
    }
  }

  Future<void> _useFingerprint() async {
    setState(() => _error = null);
    try {
      if (await _vault.unlockWithFingerprint()) await widget.onOpened();
    } on VaultProblem catch (e) {
      if (mounted) setState(() => _error = e.message);
    } catch (_) {
      if (mounted) setState(() => _error = 'Fingerprint did not work. Use your password.');
    }
  }

  Future<void> _forgot() async {
    var empty = false;
    try {
      empty = await _vault.canStartOver();
    } catch (_) {}
    if (!mounted) return;
    final start = await showDialog<bool>(
      context: context,
      builder: (d) => AlertDialog(
        title: const Text('Forgot your password?'),
        content: Text(empty
            ? 'The password cannot be reset: nobody else can open your vault. Your vault has no evidence yet, '
                'so you can start a new one with a new password.'
            : 'The password cannot be reset: nobody else can open your vault, not even Sarthi Rakshak. '
                'Without it, the evidence in it cannot be opened. Try the passwords you usually use.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(d, false), child: Text(empty ? 'Cancel' : 'OK')),
          if (empty) FilledButton(onPressed: () => Navigator.pop(d, true), child: const Text('Start a new vault')),
        ],
      ),
    );
    if (start == true) widget.onStartOver();
  }

  @override
  Widget build(BuildContext context) => ListView(padding: const EdgeInsets.fromLTRB(20, 24, 20, 24), children: [
        const VaultHero(),
        const SizedBox(height: 24),
        const ScreenTitle('Enter your password'),
        const SizedBox(height: 16),
        PasswordField(controller: _password, label: 'Password', onSubmitted: (_) => _open()),
        if (_error != null) Padding(padding: const EdgeInsets.only(top: 12), child: Text(_error!, key: const Key('vault-error'), style: const TextStyle(color: AppColors.red))),
        const SizedBox(height: 20),
        BusyButton(label: 'Open', icon: Icons.lock_open_outlined, onPressed: _open),
        if (_fingerprint) ...[
          const SizedBox(height: 12),
          OutlinedButton.icon(
            key: const Key('vault-fingerprint'),
            onPressed: _useFingerprint,
            icon: const Icon(Icons.fingerprint),
            label: const Text('Use fingerprint'),
          ),
        ],
        const SizedBox(height: 8),
        TextButton(onPressed: _forgot, child: const Text('Forgot password?')),
      ]);
}

/// Mere Saboot → Password: change it, and turn fingerprint opening on or off. The vault must be open.
class VaultPasswordScreen extends StatefulWidget {
  const VaultPasswordScreen({super.key});

  @override
  State<VaultPasswordScreen> createState() => _VaultPasswordScreenState();
}

class _VaultPasswordScreenState extends State<VaultPasswordScreen> {
  late final VaultSession _vault = AppScope.read(context).vault;
  final _current = TextEditingController();
  final _password = TextEditingController();
  final _again = TextEditingController();
  bool? _fingerprint;
  String? _error;

  @override
  void initState() {
    super.initState();
    _vault.fingerprintOn().then((on) {
      if (mounted) setState(() => _fingerprint = on);
    });
  }

  @override
  void dispose() {
    _current.dispose();
    _password.dispose();
    _again.dispose();
    super.dispose();
  }

  Future<void> _change() async {
    if (_password.text.isEmpty) {
      setState(() => _error = 'Enter a new password.');
      return;
    }
    if (_password.text != _again.text) {
      setState(() => _error = 'The two new passwords are not the same.');
      return;
    }
    setState(() => _error = null);
    try {
      await _vault.changePassword(_current.text, _password.text);
      if (!mounted) return;
      await showDialog<void>(
        context: context,
        barrierDismissible: false,
        builder: (c) => AlertDialog(
          icon: const Icon(Icons.check_circle_outline, color: AppColors.green, size: 40),
          title: const Text('Password changed'),
          content: const Text('Use the new password from now on. Your evidence is unchanged.'),
          actions: [
            FilledButton(
              style: FilledButton.styleFrom(minimumSize: const Size(0, 44)),
              onPressed: () => Navigator.pop(c),
              child: const Text('OK'),
            ),
          ],
        ),
      );
      if (mounted) Navigator.pop(context);
    } on VaultProblem catch (e) {
      if (mounted) setState(() => _error = e.message);
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } catch (_) {
      if (mounted) setState(() => _error = 'Could not change the password. Please try again.');
    }
  }

  Future<void> _setFingerprint(bool on) async {
    try {
      final ok = await _vault.setFingerprint(on);
      if (mounted && ok) setState(() => _fingerprint = on);
    } on VaultProblem catch (e) {
      if (mounted) showInfo(context, e.message);
    } catch (_) {
      if (mounted) showInfo(context, 'Could not change fingerprint opening. Please try again.');
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: const Text('Password')),
        body: ListView(padding: const EdgeInsets.fromLTRB(20, 16, 20, 32), children: [
          if (_fingerprint != null)
            SwitchListTile(
              key: const Key('fingerprint-switch'),
              contentPadding: EdgeInsets.zero,
              value: _fingerprint!,
              onChanged: _setFingerprint,
              title: const Text('Open with fingerprint', style: TextStyle(fontWeight: FontWeight.w600)),
              subtitle: const Text('On this phone. The password always works too.'),
            ),
          const SizedBox(height: 12),
          const SectionLabel('Change password'),
          PasswordField(controller: _current, label: 'Current password'),
          const SizedBox(height: 12),
          PasswordField(controller: _password, label: 'New password'),
          const SizedBox(height: 12),
          PasswordField(controller: _again, label: 'Type the new password again', onSubmitted: (_) => _change()),
          if (_error != null) Padding(padding: const EdgeInsets.only(top: 12), child: Text(_error!, key: const Key('vault-error'), style: const TextStyle(color: AppColors.red))),
          const SizedBox(height: 20),
          BusyButton(label: 'Change password', onPressed: _change),
          const SizedBox(height: 14),
          const NoticeBox(text: 'If you forget your password, nobody can open your evidence, not even Sarthi Rakshak.'),
        ]),
      );
}
