import 'dart:async';

import 'package:flutter/material.dart';
import 'package:in_app_purchase/in_app_purchase.dart';

import '../../api/api_client.dart';
import '../../api/phase2_api.dart';
import '../../state/app_state.dart';
import '../../theme.dart';
import '../../widgets/common.dart';
import '../../widgets/format.dart';

String storageText(int mb) => mb >= 1024 ? '${(mb / 1024).toStringAsFixed(mb % 1024 == 0 ? 0 : 1)} GB' : '$mb MB';

/// Plans (feature 24). While everything is free, plans are shown as "Coming soon". Payment is
/// through Google Play only when an admin puts a plan on sale; refunds are handled by Google.
class PlansScreen extends StatefulWidget {
  const PlansScreen({super.key});

  @override
  State<PlansScreen> createState() => _PlansScreenState();
}

class _PlansScreenState extends State<PlansScreen> {
  late final AppState _state = AppScope.read(context);
  PlansReply? _reply;
  String? _error;
  StreamSubscription<List<PurchaseDetails>>? _purchases;
  Map<String, ProductDetails> _products = {};
  bool _buying = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _purchases?.cancel();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final r = await _state.api.plans();
      if (!mounted) return;
      setState(() {
        _reply = r;
        _error = null;
      });
      if (!r.everythingFree && r.plans.any((p) => p.onSale)) await _setUpStore(r);
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } catch (_) {
      if (mounted) setState(() => _error = 'Could not load plans. Please try again.');
    }
  }

  Future<void> _setUpStore(PlansReply r) async {
    final iap = InAppPurchase.instance;
    if (!await iap.isAvailable()) return;
    _purchases ??= iap.purchaseStream.listen(_onPurchases, onError: (_) {});
    final ids = {
      for (final p in r.plans.where((p) => p.onSale)) ...[?p.monthlyProductId, ?p.yearlyProductId],
    };
    final res = await iap.queryProductDetails(ids);
    if (mounted) setState(() => _products = {for (final p in res.productDetails) p.id: p});
  }

  Future<void> _onPurchases(List<PurchaseDetails> list) async {
    for (final p in list) {
      if (p.status == PurchaseStatus.purchased || p.status == PurchaseStatus.restored) {
        try {
          // The server checks the purchase with Google before the plan changes.
          final r = await _state.api.verifyPurchase(p.productID, p.verificationData.serverVerificationData);
          if (mounted) setState(() => _reply = r);
          if (p.pendingCompletePurchase) await InAppPurchase.instance.completePurchase(p);
          if (mounted) showInfo(context, 'Thank you. Your plan is active.');
        } catch (e) {
          if (mounted) showError(context, e);
        }
      } else if (p.status == PurchaseStatus.error && mounted) {
        showInfo(context, 'The payment did not go through. You were not charged.');
      }
    }
    if (mounted) setState(() => _buying = false);
  }

  Future<void> _buy(String productId) async {
    final product = _products[productId];
    if (product == null) {
      showInfo(context, 'This plan is not available on Google Play yet.');
      return;
    }
    setState(() => _buying = true);
    try {
      await InAppPurchase.instance.buyNonConsumable(purchaseParam: PurchaseParam(productDetails: product, applicationUserName: _state.me?.id));
    } catch (e) {
      if (mounted) {
        setState(() => _buying = false);
        showError(context, e);
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final r = _reply;
    return Scaffold(
      appBar: AppBar(title: const Text('Plans')),
      body: r == null
          ? Center(
              child: _error == null
                  ? const CircularProgressIndicator()
                  : Column(mainAxisSize: MainAxisSize.min, children: [
                      Text(_error!),
                      const SizedBox(height: 12),
                      OutlinedButton(onPressed: _load, child: const Text('Try again')),
                    ]),
            )
          : ListView(padding: const EdgeInsets.fromLTRB(20, 8, 20, 32), children: [
              if (r.everythingFree)
                const NoticeBox(
                  text: 'Everything is free for now, including the largest evidence storage. Paid plans are coming later; we will tell you before anything changes.',
                  icon: Icons.celebration_outlined,
                  color: AppColors.green,
                  background: AppColors.greenSoft,
                ),
              if (!r.everythingFree && r.renewsAt != null)
                NoticeBox(text: 'Your plan renews on ${dateTime(r.renewsAt!)}. Manage or cancel it in Google Play → Subscriptions.'),
              const SizedBox(height: 16),
              for (final p in r.plans)
                Padding(
                  padding: const EdgeInsets.only(bottom: 12),
                  child: AppCard(
                    child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Row(children: [
                        Expanded(child: Text(p.name, style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w800))),
                        if (!r.everythingFree && r.current == p.id)
                          const StatusPill('Your plan', color: AppColors.green)
                        else if (r.everythingFree || !p.onSale)
                          const StatusPill('Coming soon', color: AppColors.amber),
                      ]),
                      const SizedBox(height: 4),
                      Text('${storageText(p.evidenceStorageMb)} evidence storage', style: const TextStyle(color: AppColors.muted)),
                      const SizedBox(height: 10),
                      for (final f in p.features)
                        Padding(
                          padding: const EdgeInsets.only(bottom: 4),
                          child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                            const Icon(Icons.check, size: 18, color: AppColors.green),
                            const SizedBox(width: 8),
                            Expanded(child: Text(f)),
                          ]),
                        ),
                      if (!r.everythingFree && p.onSale && r.current != p.id) ...[
                        const SizedBox(height: 10),
                        Row(children: [
                          if (p.monthlyProductId != null)
                            Expanded(
                              child: FilledButton(
                                onPressed: _buying ? null : () => _buy(p.monthlyProductId!),
                                child: Text(_products[p.monthlyProductId]?.price ?? '₹${p.monthlyPriceInr ?? '-'} / month'),
                              ),
                            ),
                          if (p.monthlyProductId != null && p.yearlyProductId != null) const SizedBox(width: 10),
                          if (p.yearlyProductId != null)
                            Expanded(
                              child: OutlinedButton(
                                onPressed: _buying ? null : () => _buy(p.yearlyProductId!),
                                child: Text(_products[p.yearlyProductId]?.price ?? '₹${p.yearlyPriceInr ?? '-'} / year'),
                              ),
                            ),
                        ]),
                      ],
                    ]),
                  ),
                ),
              const Text('Payments go through Google Play. Refunds follow Google Play\'s refund policy.',
                  style: TextStyle(color: AppColors.muted, fontSize: 13, height: 1.4)),
            ]),
    );
  }
}
