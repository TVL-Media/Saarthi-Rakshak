import { useQuery } from '@tanstack/react-query';
import { Alert, Tag } from 'antd';
import { useEffect, useRef } from 'react';
import { Link, useLocation } from 'react-router';
import { api, post } from '../api';
import type { DashboardState } from '../auth/TwoStepPage';
import { EmptyState, ErrorState, LoadingState, SectionCard } from '../components/states';
import { formatTimeShort } from '../format';
import type { HistoryLinkState } from './HistoryPage';
import type { UsersLinkState } from './UsersPage';

type HealthState = 'working' | 'slow' | 'down' | 'not_set_up';

type AttentionItem =
  | { kind: 'sos_no_response'; sosId: string; since: string }
  | { kind: 'sos_lost_contact'; sosId: string; since: string }
  | { kind: 'checkin_no_reply'; journeyId: string; since: string }
  | { kind: 'sms_all_failed'; sosId: string | null; journeyId: string | null; since: string }
  | { kind: 'journey_lost_contact'; journeyId: string; since: string }
  | { kind: 'setup_unfinished'; count: number };

interface RecentEvent {
  kind:
    | 'user_signed_up'
    | 'sos_started'
    | 'sos_ended'
    | 'sos_cancelled'
    | 'journey_started'
    | 'journey_arrived';
  at: string;
  sosId: string | null;
}

interface Summary {
  counts: {
    activeSos: number;
    activeJourneys: number;
    sosToday: number;
    newUsersToday: number;
    failedAlertsToday: number;
  };
  health: Record<'server' | 'database' | 'redis' | 'push' | 'smsMain' | 'smsBackup', HealthState>;
  attention: AttentionItem[];
  recent: RecentEvent[];
}

/** The page refreshes every 30 seconds (live updates come with the Live SOS screen). */
const REFRESH_MS = 30_000;

const HEALTH_ROWS: [keyof Summary['health'], string][] = [
  ['server', 'Server'],
  ['database', 'Database'],
  ['redis', 'Live data (Redis)'],
  ['push', 'Push notifications'],
  ['smsMain', 'SMS · main provider'],
  ['smsBackup', 'SMS · backup provider'],
];

const HEALTH_BADGE: Record<HealthState, { label: string; tone: string }> = {
  working: { label: 'Working', tone: 'ok' },
  slow: { label: 'Slow', tone: 'warn' },
  down: { label: 'Down', tone: 'bad' },
  not_set_up: { label: 'Not set up', tone: 'off' },
};

function minutesSince(iso: string): number {
  return Math.max(1, Math.round((Date.now() - Date.parse(iso)) / 60_000));
}

/** One "Needs attention" line: words, where it links, and red when an SOS is involved. */
function attentionLine(item: AttentionItem): {
  text: string;
  to: string;
  state?: unknown;
  urgent: boolean;
} {
  const journey = (id: string): HistoryLinkState => ({ open: { type: 'journey', id } });
  switch (item.kind) {
    case 'sos_no_response':
      return { text: 'Active SOS: no guardian has responded yet', to: '/live', urgent: true };
    case 'sos_lost_contact':
      return {
        text: `Active SOS: no location for ${minutesSince(item.since)} min`,
        to: '/live',
        urgent: true,
      };
    case 'checkin_no_reply':
      return {
        text: 'Check-in not answered · guardians were alerted',
        to: '/history',
        state: journey(item.journeyId),
        urgent: false,
      };
    case 'sms_all_failed':
      return {
        text: 'SMS: all tries failed. Check provider status.',
        to: '/alerts',
        urgent: false,
      };
    case 'journey_lost_contact':
      return {
        text: 'Journey lost contact · guardians were alerted',
        to: '/history',
        state: journey(item.journeyId),
        urgent: false,
      };
    case 'setup_unfinished': {
      const state: UsersLinkState = { filter: { setup: 'unfinished' } };
      const people = item.count === 1 ? '1 user has' : `${item.count} users have`;
      return { text: `${people} unfinished setup`, to: '/users', state, urgent: false };
    }
  }
}

const RECENT_TEXT: Record<RecentEvent['kind'], string> = {
  user_signed_up: 'New user signed up',
  sos_started: 'SOS started',
  sos_ended: 'SOS ended: user safe',
  sos_cancelled: 'SOS cancelled in countdown',
  journey_started: 'Journey started',
  journey_arrived: 'Journey arrived safely',
};

export function DashboardBody() {
  const backupCodesLeft = (useLocation().state as DashboardState | null)?.backupCodesLeft;
  const summary = useQuery({
    queryKey: ['dashboard'],
    queryFn: () => api<Summary>('/admin/dashboard'),
    refetchInterval: REFRESH_MS,
  });

  // One audit entry per visit (the 30-second refreshes are not logged).
  const logged = useRef(false);
  useEffect(() => {
    if (logged.current) return;
    logged.current = true;
    void post('/admin/dashboard/viewed').catch(() => undefined);
  }, []);

  const banner = backupCodesLeft !== undefined && (
    <Alert type="warning" title={`You used a backup code. ${backupCodesLeft} left.`} />
  );
  if (summary.isPending) {
    return (
      <>
        {banner}
        <LoadingState />
      </>
    );
  }
  if (summary.isError) return <ErrorState onRetry={() => void summary.refetch()} />;
  const { counts, health, attention, recent } = summary.data;

  return (
    <>
      {banner}
      <div className="sr-stat-grid">
        {(
          [
            ['Active SOS', counts.activeSos, true],
            ['Active journeys', counts.activeJourneys, false],
            ['SOS today', counts.sosToday, false],
            ['New users today', counts.newUsersToday, false],
            ['Failed alerts today', counts.failedAlertsToday, false],
          ] as const
        ).map(([label, value, sos]) => (
          <SectionCard key={label}>
            <div className={sos ? 'sr-stat sos' : 'sr-stat'}>
              <span>{label}</span>
              <b>{value}</b>
            </div>
          </SectionCard>
        ))}
      </div>

      <div className="sr-cols">
        <SectionCard>
          <div className="sr-card-head">
            <h2 className="sr-card-title">Noida map</h2>
            <Tag className="sr-tag">Journeys in progress: {counts.activeJourneys}</Tag>
          </div>
          <div className="sr-map">
            {counts.activeSos > 0 ? (
              <div className="sr-empty">
                <b className="sr-err-text sr-strong">
                  {counts.activeSos} active SOS · <Link to="/live">Open Live SOS</Link>
                </b>
                <p>The map appears here once Google Maps is set up.</p>
              </div>
            ) : (
              <EmptyState
                icon="sos"
                title="No active SOS"
                text="SOS locations appear here only while an SOS is active. Journeys are shown as a count, not on the map."
              />
            )}
          </div>
        </SectionCard>
        <SectionCard title="System health">
          <div className="sr-status-list">
            {HEALTH_ROWS.map(([key, label]) => (
              <div className="sr-status-row" key={key}>
                <span>{label}</span>
                <span className={`sr-badge ${HEALTH_BADGE[health[key]].tone}`}>
                  {HEALTH_BADGE[health[key]].label}
                </span>
              </div>
            ))}
          </div>
        </SectionCard>
      </div>

      <div className="sr-cols">
        <SectionCard title="Needs attention">
          {attention.length === 0 ? (
            <EmptyState
              icon="inbox"
              title="Nothing needs attention"
              text="Failed alerts, lost contact and users whose setup is unfinished will show here."
            />
          ) : (
            <div className="sr-status-list">
              {attention.map((item, i) => {
                const line = attentionLine(item);
                return (
                  <div className="sr-status-row" key={i}>
                    <Link
                      to={line.to}
                      state={line.state}
                      className={line.urgent ? 'sr-urgent' : undefined}
                    >
                      {line.text}
                    </Link>
                    {'since' in item && (
                      <span className="sr-mono sr-hint">{formatTimeShort(item.since)}</span>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </SectionCard>
        <SectionCard title="Recent events">
          {recent.length === 0 ? (
            <EmptyState
              icon="list"
              title="No events yet"
              text="Sign-ups, SOS and journeys appear here as they happen."
            />
          ) : (
            <div className="sr-status-list">
              {recent.map((e, i) => {
                const state: HistoryLinkState | undefined = e.sosId
                  ? { open: { type: 'sos', id: e.sosId } }
                  : undefined;
                return (
                  <div className="sr-status-row" key={i}>
                    {state ? (
                      <Link to="/history" state={state}>
                        {RECENT_TEXT[e.kind]}
                      </Link>
                    ) : (
                      <span>{RECENT_TEXT[e.kind]}</span>
                    )}
                    <span className="sr-mono sr-hint">{formatTimeShort(e.at)}</span>
                  </div>
                );
              })}
            </div>
          )}
        </SectionCard>
      </div>
    </>
  );
}
