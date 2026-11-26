import { Table } from 'antd';
import type { ReactNode } from 'react';
import { EmptyState, SectionCard, type IconName } from '../components/states';
import { AlertsBody } from './AlertsPage';
import { AuditBody } from './AuditPage';
import { DashboardBody } from './DashboardPage';
import { HistoryBody } from './HistoryPage';
import { LiveBody } from './LivePage';
import { CommunityBody, Phase2Stats, PlansBody, RakshakBody } from './Phase2Pages';
import { BookingsBody } from './Phase3Pages';
import { SafetyServicesBody } from './Phase4Pages';
import { SettingsBody } from './SettingsPage';
import { TeamBody } from './TeamPage';
import { UsersBody } from './UsersPage';

// Step 6: each screen has its title and the empty states from the design. Data comes with each
// screen's own step (filters, stat cards and health are left out until then).

/** A table with the design's column headings and its empty state. */
function EmptyTable(props: { columns: string[]; icon: IconName; title: string; text: string }) {
  return (
    <Table
      className="sr-table"
      columns={props.columns.map((c) => ({ title: c, key: c }))}
      dataSource={[]}
      pagination={false}
      scroll={{ x: 'max-content' }}
      locale={{ emptyText: <EmptyState icon={props.icon} title={props.title} text={props.text} /> }}
    />
  );
}

function Support() {
  return (
    <SectionCard>
      <EmptyTable
        columns={['Received', 'User', 'Subject', 'Status', 'Assigned to']}
        icon="inbox"
        title="No tickets yet"
        text="When a user taps “Report a problem” in the app, the ticket appears here."
      />
    </SectionCard>
  );
}

function Reports() {
  const charts: [string, string][] = [
    ['Sign-ups', 'Starts when the first user signs up.'],
    ['SOS and false alarms', 'Real SOS vs SOS cancelled during the countdown.'],
    ['Alert delivery rate', 'Share of SMS and push alerts delivered.'],
    ['Phones with problems', 'Phone models where the app was stopped or lost contact.'],
  ];
  return (
    <>
      <div className="sr-chart-grid">
        {charts.map(([title, text]) => (
          <SectionCard key={title} title={title}>
            <EmptyState icon="chart" title="No data yet" text={text} />
          </SectionCard>
        ))}
      </div>
      <Phase2Stats />
    </>
  );
}

export interface Screen {
  path: string;
  menu: string;
  title: string;
  sub: string;
  /** An extra line under the subtitle. */
  note?: string;
  superOnly?: boolean;
  body?: () => ReactNode;
}

export const MAIN_SCREENS: Screen[] = [
  {
    path: '/',
    menu: 'Dashboard',
    title: 'Dashboard',
    sub: 'Noida pilot · updates live',
    body: DashboardBody,
  },
  { path: '/live', menu: 'Live SOS', title: 'Live SOS', sub: 'View only', body: LiveBody },
  { path: '/users', menu: 'Users', title: 'Users', sub: 'Search by phone number', body: UsersBody },
  {
    path: '/history',
    menu: 'SOS & Journey History',
    title: 'SOS & Journey History',
    sub: 'Read only · records cannot be edited or deleted',
    body: HistoryBody,
  },
  {
    path: '/alerts',
    menu: 'Alert Log',
    title: 'Alert Log',
    sub: 'Every SMS and push message, failed first',
    note: "Login OTPs are sent by Firebase and don't appear here.",
    body: AlertsBody,
  },
  {
    path: '/support',
    menu: 'Support Tickets',
    title: 'Support Tickets',
    sub: 'Problems reported by users from the app',
    body: Support,
  },
  {
    path: '/community',
    menu: 'Community',
    title: 'Community moderation',
    sub: 'Approve, edit or reject safety reports before anyone sees them',
    body: CommunityBody,
  },
  {
    path: '/bookings',
    menu: 'Bookings',
    title: 'Bookings',
    sub: 'Book a Rakshak · quote, assign and follow each booking',
    body: BookingsBody,
  },
  {
    path: '/safety-services',
    menu: 'Safety Services',
    title: 'Safety Services',
    sub: 'Partners, support and legal requests, and reviewed guidance',
    body: SafetyServicesBody,
  },
  { path: '/reports', menu: 'Reports', title: 'Reports', sub: 'Pilot numbers', body: Reports },
];

// The Super Admin screens.
export const SUPER_ADMIN_SCREENS: Screen[] = [
  {
    path: '/settings',
    menu: 'Settings',
    title: 'Settings',
    sub: 'Super Admin only · every change is recorded in the audit log',
    superOnly: true,
    body: SettingsBody,
  },
  {
    path: '/team',
    menu: 'Admin Team',
    title: 'Admin Team',
    sub: 'Super Admin only',
    superOnly: true,
    body: TeamBody,
  },
  {
    path: '/rakshak',
    menu: 'Rakshak Applications',
    title: 'Rakshak Applications',
    sub: 'Super Admin only · every view is recorded in the audit log',
    superOnly: true,
    body: RakshakBody,
  },
  {
    path: '/plans',
    menu: 'Plans & Subscriptions',
    title: 'Plans & Subscriptions',
    sub: 'Super Admin only · payments go through Google Play',
    superOnly: true,
    body: PlansBody,
  },
  {
    path: '/audit',
    menu: 'Audit Log',
    title: 'Audit Log',
    sub: 'Super Admin only · cannot be edited or deleted',
    superOnly: true,
    body: AuditBody,
  },
];
