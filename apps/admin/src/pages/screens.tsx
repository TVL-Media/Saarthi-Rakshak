import { Alert, Table } from 'antd';
import type { ReactNode } from 'react';
import { useLocation } from 'react-router';
import { EmptyState, SectionCard, type IconName } from '../components/states';
import { SettingsBody } from './SettingsPage';
import { TeamBody } from './TeamPage';
import type { DashboardState } from '../auth/TwoStepPage';

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

function Dashboard() {
  const left = (useLocation().state as DashboardState | null)?.backupCodesLeft;
  return (
    <>
      {left !== undefined && (
        <Alert type="warning" title={`You used a backup code. ${left} left.`} />
      )}
      <SectionCard title="Noida map">
        <div className="sr-map">
          <EmptyState
            icon="sos"
            title="No active SOS"
            text="SOS locations appear here only while an SOS is active. Journeys are shown as a count, not on the map."
          />
        </div>
      </SectionCard>
      <div className="sr-cols">
        <SectionCard title="Needs attention">
          <EmptyState
            icon="inbox"
            title="Nothing needs attention"
            text="Failed alerts, lost contact and users whose setup is unfinished will show here."
          />
        </SectionCard>
        <SectionCard title="Recent events">
          <EmptyState
            icon="list"
            title="No events yet"
            text="Sign-ups, SOS and journeys appear here as they happen."
          />
        </SectionCard>
      </div>
    </>
  );
}

function LiveSos() {
  return (
    <>
      <Alert
        type="warning"
        title={
          <span>
            <b>View only.</b> Admins cannot act on an SOS. Guardians and 112 respond. Sarthi Rakshak
            alerts your guardians and helps you call 112. It is not a 24/7 monitoring service.
          </span>
        }
      />
      <div className="sr-cols">
        <SectionCard title="Active SOS">
          <EmptyState
            icon="sos"
            title="No active SOS right now"
            text="When a user presses SOS, it appears here within seconds."
          />
        </SectionCard>
        <SectionCard title="Details">
          <EmptyState
            icon="list"
            title="Select an SOS"
            text="Its live map, guardians and alert status will show here."
          />
        </SectionCard>
      </div>
      <SectionCard title="Guardians for the selected SOS">
        <EmptyTable
          columns={['Guardian', 'Phone', 'SMS', 'Push', 'Opened link', 'Responding']}
          icon="user"
          title="No SOS selected"
          text="Guardian alert status appears when an SOS is selected."
        />
      </SectionCard>
    </>
  );
}

function Users() {
  return (
    <SectionCard>
      <EmptyTable
        columns={['Name', 'Phone', 'Setup', 'Guardians', 'App version', 'Last seen', 'Status']}
        icon="user"
        title="No users yet"
        text="Users appear here after they sign up in the app."
      />
    </SectionCard>
  );
}

function History() {
  return (
    <SectionCard>
      <EmptyTable
        columns={[
          'Started',
          'Type',
          'User',
          'Duration',
          'Started by',
          'Guardians alerted',
          'Outcome',
        ]}
        icon="list"
        title="No SOS or journeys yet"
        text="Every SOS and journey from the app will be listed here with its full timeline."
      />
    </SectionCard>
  );
}

function AlertLog() {
  return (
    <SectionCard title="Messages">
      <EmptyTable
        columns={['Time', 'Channel', 'Provider', 'To', 'Result', 'Next step']}
        icon="inbox"
        title="No alerts sent yet"
        text="Every SMS and push sent for an SOS, check-in or lost contact will be logged here."
      />
    </SectionCard>
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
    <div className="sr-chart-grid">
      {charts.map(([title, text]) => (
        <SectionCard key={title} title={title}>
          <EmptyState icon="chart" title="No data yet" text={text} />
        </SectionCard>
      ))}
    </div>
  );
}

export interface Screen {
  path: string;
  menu: string;
  title: string;
  sub: string;
  superOnly?: boolean;
  body?: () => ReactNode;
}

export const MAIN_SCREENS: Screen[] = [
  {
    path: '/',
    menu: 'Dashboard',
    title: 'Dashboard',
    sub: 'Noida pilot · updates live',
    body: Dashboard,
  },
  { path: '/live', menu: 'Live SOS', title: 'Live SOS', sub: 'View only', body: LiveSos },
  { path: '/users', menu: 'Users', title: 'Users', sub: 'Search by phone number', body: Users },
  {
    path: '/history',
    menu: 'SOS & Journey History',
    title: 'SOS & Journey History',
    sub: 'Read only · records cannot be edited or deleted',
    body: History,
  },
  {
    path: '/alerts',
    menu: 'Alert Log',
    title: 'Alert Log',
    sub: 'Every SMS and push message, failed first',
    body: AlertLog,
  },
  {
    path: '/support',
    menu: 'Support Tickets',
    title: 'Support Tickets',
    sub: 'Problems reported by users from the app',
    body: Support,
  },
  { path: '/reports', menu: 'Reports', title: 'Reports', sub: 'Pilot numbers', body: Reports },
];

// Admin Team and Audit Log: content comes later in step 7; title and subtitle only for now.
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
    path: '/audit',
    menu: 'Audit Log',
    title: 'Audit Log',
    sub: 'Super Admin only · cannot be edited or deleted',
    superOnly: true,
  },
];
