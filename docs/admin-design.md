# Admin Panel — Design

The admin panel design lives in **`docs/design/admin-panel.html`**. Open it in a browser and pick a screen.
It is the source of truth for the admin UI. This file gives the exact values to build it with Ant Design.

- Text in `{braces}` in the design is filled from the server. Nothing in the design is sample data.
- Each screen has a yellow note on top with its route, rules and error messages. Follow the notes.
- Desktop first (1440 wide). Under 860 px the sidebar hides behind a "Menu" button (Ant Design `Sider` breakpoint).
- Light theme only in Phase 1.

## Theme (Ant Design `ConfigProvider`)

Put this in one file (for example `apps/admin/src/theme.ts`) and use it everywhere. Do not hard-code colours in screens.

```ts
import type { ThemeConfig } from 'antd';

export const theme: ThemeConfig = {
  token: {
    colorPrimary: '#1D4E89',
    colorInfo: '#1D4E89',
    colorError: '#B42318',     // SOS and errors only
    colorSuccess: '#166534',
    colorWarning: '#9A5B00',
    colorText: '#17191C',
    colorTextSecondary: '#5B5F66',
    colorTextTertiary: '#8A8E94',
    colorBorder: '#D6D3CB',    // inputs
    colorBorderSecondary: '#E3E1DA', // cards, tables
    colorBgLayout: '#F5F4F0',
    colorBgContainer: '#FFFFFF',
    fontFamily: "'IBM Plex Sans', 'Segoe UI', system-ui, sans-serif",
    fontFamilyCode: "'IBM Plex Mono', ui-monospace, Consolas, monospace",
    fontSize: 14,
    borderRadius: 8,
    borderRadiusLG: 12,        // cards, modals
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
```

Extra colours (not Ant Design tokens): primary dark `#0F2F57`, primary light `#E8EEF6`, error light `#FDECEA`,
success light `#E7F4EC`, warning light `#FFF8E6`, sidebar muted text `#8396A7`.

**Fonts:** IBM Plex Sans (400, 500, 600, 700) and IBM Plex Mono (400, 500). Install them as npm packages
(`@fontsource/ibm-plex-sans`, `@fontsource/ibm-plex-mono`) so the font files are served by our own site.
Use Plex Mono for numbers in stat cards, times, phone numbers, codes and IDs.

| Text | Size / line height | Weight |
| --- | --- | --- |
| Page title | 24 / 32 | 700 |
| Card title | 15 / 22 | 600 |
| Body | 14 / 22 | 400 |
| Small, hints | 12 / 18 | 400 |
| Stat numbers | 26, Plex Mono | 500 |

Spacing steps: 4 · 8 · 12 · 16 · 20 · 24. Sidebar 232 px wide, top bar 60 px high, content padding 24 px, card padding 18 px.

## Layout

- **Sidebar** (dark): "SARTHI RAKSHAK / Admin · Noida pilot", then Dashboard, Live SOS, Users, SOS & Journey History,
  Alert Log, Support Tickets, Reports. Group "SUPER ADMIN ONLY": Settings, Admin Team, Audit Log (hidden for Support Admin).
  Footer: "Auto logout after 30 min without activity". Live SOS shows a red count badge when an SOS is active.
- **Top bar**: "Noida pilot" tag on the left; admin initials, name, role and "Log out" on the right.
- **Page head**: title + one-line subtitle, then the content.

## Screens and routes

| Design screen | Route | Who |
| --- | --- | --- |
| Log in, Locked, Logged out | `/login` | Everyone |
| Change password | `/change-password` | After a temporary password |
| 2-step setup, Backup codes | `/two-step/setup` | First login |
| 2-step code | `/two-step` | Every login |
| Dashboard | `/` | Both roles |
| Live SOS | `/live` | Both roles |
| Users | `/users` (profile `/users/:id`) | Both roles |
| History | `/history` | Both roles |
| Alert Log | `/alerts` | Both roles |
| Support | `/support` | Both roles |
| Reports | `/reports` | Both roles |
| Settings | `/settings` | Super Admin |
| Admin Team | `/team` | Super Admin |
| Audit Log | `/audit` | Super Admin |

Route names are a suggestion. Keep them if the server or existing code doesn't already use others.

## States every screen needs

| State | How |
| --- | --- |
| Loading | Ant Design `Skeleton` or `Table loading` in place of the content. Title and filters stay visible |
| Empty | Icon + bold line + one sentence saying what will appear and when (exact text in the design) |
| Error | "Couldn't load this page" + "Try again" button. Never show raw server errors |
| No access | "Only a Super Admin can open this page" + "Go to Dashboard". The server also returns 403 |
| Logged out | Back to `/login` with "You were logged out after 30 minutes without activity." |

## Rules shown in the design

- Phone numbers partly masked: `+91 98•• ••4521`.
- Live SOS always shows the view-only banner and the line "Sarthi Rakshak alerts your guardians and helps you call 112.
  It is not a 24/7 monitoring service."
- No play or download button for audio anywhere.
- No edit, cancel or delete on SOS history.
- Settings: "Save changes" asks for a reason, which goes into the audit log.
- Red is kept for SOS and errors only.
