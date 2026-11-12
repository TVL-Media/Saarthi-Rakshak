import 'dart:math';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../api/api_client.dart';
import '../../state/app_state.dart';
import '../../state/vault_session.dart';
import '../../theme.dart';
import '../../widgets/common.dart';
import 'vault_screen.dart';

/// The 12 words in a numbered 2-column grid.
class PhraseGrid extends StatelessWidget {
  const PhraseGrid(this.words, {super.key});
  final List<String> words;

  @override
  Widget build(BuildContext context) => AppCard(
        child: Column(children: [
          for (var r = 0; r < words.length; r += 2)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 5),
              child: Row(children: [
                for (final i in [r, r + 1])
                  if (i < words.length)
                    Expanded(
                      child: Row(children: [
                        SizedBox(width: 26, child: Text('${i + 1}.', style: const TextStyle(color: AppColors.muted))),
                        Flexible(child: Text(words[i], style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w700))),
                      ]),
                    ),
              ]),
            ),
        ]),
      );
}

/// First use: shows a new 12-word recovery phrase, checks 3 of the words, then sets up the vault.
class VaultSetupView extends StatefulWidget {
  const VaultSetupView({super.key, required this.onDone, this.changeOnly = false});
  final Future<void> Function() onDone;

  /// Only make a new phrase for an open vault (the vault key does not change).
  final bool changeOnly;

  @override
  State<VaultSetupView> createState() => _VaultSetupViewState();
}

class _VaultSetupViewState extends State<VaultSetupView> {
  late final VaultSession _vault = AppScope.read(context).vault;
  late List<String> _words;
  int _step = 0; // 0 intro, 1 words, 2 check
  late List<int> _ask;
  final _answers = List.generate(3, (_) => TextEditingController());
  String? _error;

  @override
  void initState() {
    super.initState();
    _words = AppScope.read(context).vault.newPhrase().split(' ');
    final r = Random.secure();
    final idx = List.generate(_words.length, (i) => i)..shuffle(r);
    _ask = idx.take(3).toList()..sort();
  }

  @override
  void dispose() {
    for (final c in _answers) {
      c.dispose();
    }
    super.dispose();
  }

  Future<void> _finish() async {
    for (var k = 0; k < 3; k++) {
      if (_answers[k].text.trim().toLowerCase() != _words[_ask[k]]) {
        setState(() => _error = 'Word ${_ask[k] + 1} is not right. Check what you wrote down.');
        return;
      }
    }
    setState(() => _error = null);
    try {
      if (widget.changeOnly) {
        await _vault.changePhrase(_words.join(' '));
      } else {
        await _vault.setup(_words.join(' '));
      }
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
        if (!widget.changeOnly) ...[const VaultHero(), const SizedBox(height: 20)],
        if (_step == 0) ...[
          const ScreenTitle('Your recovery phrase', subtitle: 'Only you can open your vault. Not even Sarthi Rakshak can.'),
          const SizedBox(height: 16),
          const _Point(Icons.fingerprint, 'Every time, the vault opens with your fingerprint, face or phone PIN.'),
          const _Point(Icons.key_outlined, 'You will get 12 words. If you lose this phone, they are the only way to get your evidence back.'),
          const _Point(Icons.edit_note, 'Write them on paper and keep it safe. Do not screenshot or share them.'),
          const SizedBox(height: 20),
          FilledButton(onPressed: () => setState(() => _step = 1), child: const Text('Show my 12 words')),
        ],
        if (_step == 1) ...[
          const ScreenTitle('Write these down', subtitle: 'In this order. You will need 3 of them on the next screen.'),
          const SizedBox(height: 16),
          PhraseGrid(_words),
          const SizedBox(height: 14),
          const NoticeBox(text: 'Anyone with these words and your account can open your vault. Never share them.'),
          const SizedBox(height: 20),
          FilledButton(onPressed: () => setState(() => _step = 2), child: const Text('I have written them down')),
        ],
        if (_step == 2) ...[
          const ScreenTitle('Check your words'),
          const SizedBox(height: 16),
          for (var k = 0; k < 3; k++)
            Padding(
              padding: const EdgeInsets.only(bottom: 12),
              child: TextField(
                key: Key('check-word-$k'),
                controller: _answers[k],
                autocorrect: false,
                enableSuggestions: false,
                inputFormatters: [FilteringTextInputFormatter.allow(RegExp('[a-zA-Z]'))],
                decoration: InputDecoration(labelText: 'Word ${_ask[k] + 1}'),
              ),
            ),
          if (_error != null) Padding(padding: const EdgeInsets.only(bottom: 12), child: Text(_error!, style: const TextStyle(color: AppColors.red))),
          BusyButton(label: widget.changeOnly ? 'Save new phrase' : 'Set up my vault', onPressed: _finish),
          const SizedBox(height: 8),
          TextButton(onPressed: () => setState(() => _step = 1), child: const Text('Show the words again')),
        ],
      ]);
}

class _Point extends StatelessWidget {
  const _Point(this.icon, this.text);
  final IconData icon;
  final String text;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(bottom: 12),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          IconTile(icon, size: 36),
          const SizedBox(width: 12),
          Expanded(child: Padding(padding: const EdgeInsets.only(top: 6), child: Text(text, style: const TextStyle(fontSize: 15, height: 1.4)))),
        ]),
      );
}

/// New phone / new screen lock: the 12 words bring the vault back.
class VaultRestoreView extends StatefulWidget {
  const VaultRestoreView({super.key, required this.onDone});
  final Future<void> Function() onDone;

  @override
  State<VaultRestoreView> createState() => _VaultRestoreViewState();
}

class _VaultRestoreViewState extends State<VaultRestoreView> {
  late final VaultSession _vault = AppScope.read(context).vault;
  final _words = TextEditingController();
  String? _error;

  @override
  void dispose() {
    _words.dispose();
    super.dispose();
  }

  Future<void> _restore() async {
    final phrase = _words.text;
    final count = VaultSession.wordCount(phrase);
    if (count != 12) {
      setState(() => _error = count == 0
          ? 'Enter your 12 words, in order.'
          : 'You entered $count word${count == 1 ? '' : 's'}. Enter all 12, in order.');
      return;
    }
    if (!_vault.validPhrase(phrase)) {
      setState(() => _error = 'One or more words are not right. Check the spelling and the order.');
      return;
    }
    setState(() => _error = null);
    try {
      await _vault.restore(phrase);
      await widget.onDone();
    } on VaultProblem catch (e) {
      if (mounted) setState(() => _error = e.message);
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } catch (_) {
      if (mounted) setState(() => _error = 'Could not restore the vault. Please try again.');
    }
  }

  @override
  Widget build(BuildContext context) => ListView(padding: const EdgeInsets.fromLTRB(20, 16, 20, 32), children: [
        const VaultHero(),
        const SizedBox(height: 20),
        const ScreenTitle('Restore your vault', subtitle: 'Enter the 12 words you wrote down when you set up Mere Saboot.'),
        const SizedBox(height: 16),
        TextField(
          key: const Key('restore-words'),
          controller: _words,
          minLines: 3,
          maxLines: 4,
          autocorrect: false,
          enableSuggestions: false,
          onChanged: (_) => setState(() => _error = null),
          decoration: const InputDecoration(hintText: 'word1 word2 word3 …'),
        ),
        Padding(
          padding: const EdgeInsets.only(top: 6, right: 4),
          child: Text('${VaultSession.wordCount(_words.text)} of 12 words',
              key: const Key('restore-count'),
              textAlign: TextAlign.end,
              style: const TextStyle(color: AppColors.muted, fontSize: 13)),
        ),
        if (_error != null) Padding(padding: const EdgeInsets.only(top: 12), child: Text(_error!, style: const TextStyle(color: AppColors.red))),
        const SizedBox(height: 20),
        BusyButton(label: 'Restore', onPressed: _restore),
        const SizedBox(height: 14),
        const NoticeBox(text: 'Without these words, evidence saved before cannot be opened. This is what keeps it private.'),
      ]);
}

/// Makes a new recovery phrase (the old one stops working). The vault must be open.
class NewPhraseScreen extends StatelessWidget {
  const NewPhraseScreen({super.key});

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: const Text('Recovery phrase')),
        body: VaultSetupView(
          changeOnly: true,
          onDone: () async {
            // A clear answer before leaving: the user must know the new words are the ones that count.
            await showDialog<void>(
              context: context,
              barrierDismissible: false,
              builder: (c) => AlertDialog(
                icon: const Icon(Icons.check_circle_outline, color: AppColors.green, size: 40),
                title: const Text('New recovery phrase saved'),
                content: const Text(
                    'Keep the 12 new words safe. The old words no longer work. Your evidence is unchanged.'),
                actions: [
                  FilledButton(
                    style: FilledButton.styleFrom(minimumSize: const Size(0, 44)),
                    onPressed: () => Navigator.pop(c),
                    child: const Text('OK'),
                  ),
                ],
              ),
            );
            if (context.mounted) Navigator.pop(context);
          },
        ),
      );
}
