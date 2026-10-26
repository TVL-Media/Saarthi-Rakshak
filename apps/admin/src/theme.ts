import type { ThemeConfig } from 'antd';
import type { CSSProperties } from 'react';

// The one theme file (docs/admin-design.md). Screens never hard-code colours.

export const theme: ThemeConfig = {
  token: {
    colorPrimary: '#1D4E89',
    colorInfo: '#1D4E89',
    colorError: '#B42318', // SOS and errors only
    colorSuccess: '#166534',
    colorWarning: '#9A5B00',
    colorText: '#17191C',
    colorTextSecondary: '#5B5F66',
    colorTextTertiary: '#8A8E94',
    colorBorder: '#D6D3CB', // inputs
    colorBorderSecondary: '#E3E1DA', // cards, tables
    colorBgLayout: '#F5F4F0',
    colorBgContainer: '#FFFFFF',
    fontFamily: "'IBM Plex Sans', 'Segoe UI', system-ui, sans-serif",
    fontFamilyCode: "'IBM Plex Mono', ui-monospace, Consolas, monospace",
    fontSize: 14,
    borderRadius: 8,
    borderRadiusLG: 12, // cards, modals
    controlHeight: 40,
  },
  components: {
    Layout: { siderBg: '#14202B', headerBg: '#FFFFFF', headerHeight: 60, bodyBg: '#F5F4F0' },
    Menu: {
      darkItemBg: '#14202B',
      darkItemColor: '#D7DEE5',
      darkItemHoverBg: '#1D2C3A',
      darkItemSelectedBg: '#2A3B4B',
      darkItemSelectedColor: '#FFFFFF',
      darkGroupTitleColor: '#8396A7',
    },
    Table: { headerBg: '#FAFAF8', headerColor: '#5B5F66', borderColor: '#EFEDE7' },
  },
};

/** Extra colours from the design that are not Ant Design tokens. */
export const extraColors = {
  primaryDark: '#0F2F57',
  primaryLight: '#E8EEF6',
  errorLight: '#FDECEA',
  successLight: '#E7F4EC',
  warningLight: '#FFF8E6',
  sidebarMuted: '#8396A7',
  // Also from docs/design/admin-panel.html (not listed in admin-design.md):
  errorText: '#7A1810', // text on the light error background
  warningText: '#5A3D00', // text on the light warning background
  successText: '#0F4A26', // text on the light success background
  sidebarDivider: '#22313F',
  mapBg: '#E9EEF0',
  mapLine: '#D5DDE1',
} as const;

/** The same values as CSS variables, set once on the app root and used by styles.css. */
export const cssVariables = {
  '--sr-primary': theme.token!.colorPrimary,
  '--sr-primary-dark': extraColors.primaryDark,
  '--sr-primary-light': extraColors.primaryLight,
  '--sr-error': theme.token!.colorError,
  '--sr-error-light': extraColors.errorLight,
  '--sr-success': theme.token!.colorSuccess,
  '--sr-success-light': extraColors.successLight,
  '--sr-warning': theme.token!.colorWarning,
  '--sr-warning-light': extraColors.warningLight,
  '--sr-text': theme.token!.colorText,
  '--sr-text-secondary': theme.token!.colorTextSecondary,
  '--sr-text-tertiary': theme.token!.colorTextTertiary,
  '--sr-border': theme.token!.colorBorderSecondary,
  '--sr-page': theme.token!.colorBgLayout,
  '--sr-card': theme.token!.colorBgContainer,
  '--sr-sider': theme.components!.Layout!.siderBg,
  '--sr-sider-muted': extraColors.sidebarMuted,
  '--sr-sider-divider': extraColors.sidebarDivider,
  '--sr-error-text': extraColors.errorText,
  '--sr-warning-text': extraColors.warningText,
  '--sr-success-text': extraColors.successText,
  '--sr-map-bg': extraColors.mapBg,
  '--sr-map-line': extraColors.mapLine,
  '--sr-table-head': theme.components!.Table!.headerBg,
  '--sr-font-mono': theme.token!.fontFamilyCode,
} as CSSProperties;
