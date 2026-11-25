import type { ThemeConfig } from 'antd';
import type { CSSProperties } from 'react';

// The one theme file (docs/admin-design.md). Screens never hard-code colours.
// Visual refresh (Nov 2026): cool neutral greys, one blue accent, light sidebar, flat controls.
// Red is still kept for SOS and errors only.

export const theme: ThemeConfig = {
  token: {
    colorPrimary: '#1D4E89',
    colorInfo: '#1D4E89',
    colorError: '#B42318', // SOS and errors only
    colorSuccess: '#067647',
    colorWarning: '#B54708',
    colorText: '#101828',
    colorTextSecondary: '#475467',
    colorTextTertiary: '#98A2B3',
    colorBorder: '#D0D5DD', // inputs
    colorBorderSecondary: '#E4E7EC', // cards, tables
    colorBgLayout: '#F6F7F9',
    colorBgContainer: '#FFFFFF',
    colorLink: '#1D4E89',
    controlOutline: 'rgba(29, 78, 137, 0.16)', // focus ring
    controlOutlineWidth: 3,
    fontFamily: "'IBM Plex Sans', 'Segoe UI', system-ui, sans-serif",
    fontFamilyCode: "'IBM Plex Mono', ui-monospace, Consolas, monospace",
    fontSize: 14,
    borderRadius: 8,
    borderRadiusLG: 12, // cards, modals
    borderRadiusSM: 6,
    controlHeight: 36,
    boxShadowSecondary: '0 12px 32px -8px rgba(16, 24, 40, 0.18), 0 2px 6px rgba(16, 24, 40, 0.06)',
  },
  components: {
    Layout: { siderBg: '#FFFFFF', headerBg: '#FFFFFF', headerHeight: 56, bodyBg: '#F6F7F9' },
    Menu: {
      itemBg: 'transparent',
      itemColor: '#475467',
      itemHoverBg: '#F2F4F7',
      itemHoverColor: '#101828',
      itemSelectedBg: '#EAF1FA',
      itemSelectedColor: '#123660',
      itemBorderRadius: 8,
      groupTitleColor: '#98A2B3',
      iconSize: 16,
      collapsedIconSize: 16,
    },
    Table: {
      headerBg: '#F9FAFB',
      headerColor: '#475467',
      borderColor: '#EAECF0',
      rowHoverBg: '#F9FAFB',
      cellPaddingBlock: 12,
      headerSplitColor: 'transparent',
    },
    Button: { primaryShadow: 'none', defaultShadow: 'none', dangerShadow: 'none', fontWeight: 500 },
    Card: { headerFontSize: 15 },
    Modal: { titleFontSize: 16 },
    Segmented: { trackBg: '#EAECF0', itemSelectedBg: '#FFFFFF' },
    Tag: { defaultBg: '#F2F4F7', defaultColor: '#344054' },
  },
};

/** Extra colours from the design that are not Ant Design tokens. */
export const extraColors = {
  primaryDark: '#123660',
  primaryLight: '#EAF1FA',
  errorLight: '#FEF3F2',
  successLight: '#ECFDF3',
  warningLight: '#FFFAEB',
  sidebarMuted: '#667085',
  errorText: '#912018', // text on the light error background
  warningText: '#93370D', // text on the light warning background
  successText: '#05603A', // text on the light success background
  sidebarDivider: '#EAECF0',
  mapBg: '#EEF2F6',
  mapLine: '#DDE3EA',
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
  '--sr-border-input': theme.token!.colorBorder,
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
  '--sr-shadow': '0 1px 2px rgba(16, 24, 40, 0.05)',
  '--sr-shadow-pop': '0 8px 24px -6px rgba(16, 24, 40, 0.14)',
} as CSSProperties;
