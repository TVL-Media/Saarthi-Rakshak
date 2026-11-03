import 'package:flutter/material.dart';

/// Colours and shapes taken from the RAKSHAK-APP Figma design (docs/design/mobile/).
class AppColors {
  static const red = Color(0xFFEE1D23);
  static const redDark = Color(0xFFB3141A);
  static const redSoft = Color(0xFFFDE8E8);
  static const cream = Color(0xFFF8F5F1);
  static const card = Color(0xFFFFFFFF);
  static const ink = Color(0xFF111827);
  static const muted = Color(0xFF6B7280);
  static const line = Color(0xFFE7E2DC);
  static const night = Color(0xFF111418);
  static const green = Color(0xFF16875A);
  static const greenSoft = Color(0xFFE3F4EC);
  static const amber = Color(0xFFB26A00);
  static const amberSoft = Color(0xFFFFF3DD);
}

ThemeData buildTheme() {
  final base = ThemeData(
    useMaterial3: true,
    colorScheme: ColorScheme.fromSeed(
      seedColor: AppColors.red,
      primary: AppColors.red,
      surface: AppColors.cream,
      onSurface: AppColors.ink,
    ),
    scaffoldBackgroundColor: AppColors.cream,
  );
  final radius = BorderRadius.circular(14);
  return base.copyWith(
    appBarTheme: const AppBarTheme(
      backgroundColor: AppColors.cream,
      foregroundColor: AppColors.ink,
      elevation: 0,
      scrolledUnderElevation: 0,
      centerTitle: true,
      titleTextStyle: TextStyle(color: AppColors.ink, fontSize: 19, fontWeight: FontWeight.w700),
    ),
    textTheme: base.textTheme.apply(bodyColor: AppColors.ink, displayColor: AppColors.ink),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        backgroundColor: AppColors.red,
        foregroundColor: Colors.white,
        minimumSize: const Size.fromHeight(54),
        textStyle: const TextStyle(fontSize: 17, fontWeight: FontWeight.w600),
        shape: RoundedRectangleBorder(borderRadius: radius),
      ),
    ),
    outlinedButtonTheme: OutlinedButtonThemeData(
      style: OutlinedButton.styleFrom(
        foregroundColor: AppColors.ink,
        minimumSize: const Size.fromHeight(54),
        side: const BorderSide(color: AppColors.line),
        backgroundColor: Colors.white,
        textStyle: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600),
        shape: RoundedRectangleBorder(borderRadius: radius),
      ),
    ),
    textButtonTheme: TextButtonThemeData(
      style: TextButton.styleFrom(
        foregroundColor: AppColors.muted,
        textStyle: const TextStyle(fontSize: 16, fontWeight: FontWeight.w500),
      ),
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: Colors.white,
      contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 16),
      border: OutlineInputBorder(borderRadius: radius, borderSide: const BorderSide(color: AppColors.line)),
      enabledBorder:
          OutlineInputBorder(borderRadius: radius, borderSide: const BorderSide(color: AppColors.line)),
      focusedBorder:
          OutlineInputBorder(borderRadius: radius, borderSide: const BorderSide(color: AppColors.red, width: 1.5)),
      hintStyle: const TextStyle(color: AppColors.muted),
    ),
    cardTheme: CardThemeData(
      color: AppColors.card,
      elevation: 0,
      margin: EdgeInsets.zero,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
    ),
    snackBarTheme: const SnackBarThemeData(behavior: SnackBarBehavior.floating),
  );
}
