import { useQuery } from '@tanstack/react-query';
import { Alert, Table, Tag } from 'antd';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { api, ApiError, post } from '../api';
import { EmptyState, ErrorState, LoadingState, SectionCard } from '../components/states';
import { formatTimeShort } from '../format';
import type { HistoryLinkState } from './HistoryPage';

/** Until live updates (WebSocket) come with the app's server routes. */
const REFRESH_MS = 5_000;

interface LiveSosRow {
  id: string;
  startedAt: string;
  isTest: boolean;
  trigger: string;
  phone: string | null;
  lastLocationAt: string | null;
  lostContact: boolean;
  anyoneResponding: boolean;
}

interface LiveGuardian {
  label: string;
  sms: 'queued' | 'sent' | 'delivered' | 'failed' | null;
  push: 'queued' | 'sent' | 'failed' | null;
  openedAt: string | null;
  respondingAt: string | null;
}

type Details =
  | {
      ended: false;
      id: string;
      startedAt: string;
      isTest: boolean;
      trigger: string;
      user: { id: string; name: string | null; phone: string | null } | null;
      lastLocation: { at: string; accuracyM: number | null } | null;
      battery: number | null;
      network: string | null;
      lostContact: boolean;
      lostContactMinutes: number;
      guardians: LiveGuardian[];
      audio: { clips: number };
    }
  | { ended: true; id: string; outcome: 'ended_safe' | 'cancelled'; endedAt: string | null };

const TRIGGER: Record<string, string> = {
  button: 'SOS button',
  widget: 'Home-screen widget',
  tile: 'Quick-settings tile',
  checkin: 'Check-in',
  journey: 'Journey',
};

function minutesSince(iso: string): number {
  return Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 60_000));
}

/** "12 min" / "1 h 5 min" */
function runningFor(iso: string): string {
  const m = minutesSince(iso);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

function StatusBadge({ value }: { value: string | null }) {
  if (!value) return <span className="sr-muted">—</span>;
  const tone = value === 'failed' ? 'bad' : value === 'queued' ? 'off' : 'ok';
  const label =
    { queued: 'Waiting', sent: 'Sent', delivered: 'Delivered', failed: 'Failed' }[value] ?? value;
  return <span className={`sr-badge ${tone}`}>{label}</span>;
}

export function LiveBody() {
  const [selected, setSelected] = useState<string | null>(null);
  const list = useQuery({
    queryKey: ['live'],
    queryFn: () => api<LiveSosRow[]>('/admin/live'),
    refetchInterval: REFRESH_MS,
  });

  // One audit entry per visit (the 5-second refreshes are not logged).
  const logged = useRef(false);
  useEffect(() => {
    if (logged.current) return;
    logged.current = true;
    void post('/admin/live/viewed').catch(() => undefined);
  }, []);

  const open = (id: string) => {
    setSelected(id);
    // Opening an SOS shows a person's live status: logged every time.
    void post(`/admin/live/${id}/viewed`).catch(() => undefined);
  };

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
          {list.isPending && <LoadingState />}
          {list.isError && <ErrorState onRetry={() => void list.refetch()} />}
          {list.isSuccess &&
            (list.data.length === 0 ? (
              <EmptyState
                icon="sos"
                title="No active SOS right now"
                text="When a user presses SOS, it appears here within seconds."
              />
            ) : (
              <div className="sr-sos-list" role="list">
                {list.data.map((s) => (
                  <button
                    type="button"
                    role="listitem"
                    key={s.id}
                    className={s.id === selected ? 'sr-sos-item on' : 'sr-sos-item'}
                    onClick={() => open(s.id)}
                  >
                    <span className="sr-sos-item-top">
                      <span className="sr-mono">{s.phone ?? 'Deleted user'}</span>
                      <span className="sr-mono sr-hint">{runningFor(s.startedAt)}</span>
                    </span>
                    <span className="sr-tags">
                      {s.lostContact && <Tag className="sr-tag sr-tag-bad">Lost contact</Tag>}
                      {!s.anyoneResponding && (
                        <Tag className="sr-tag sr-tag-bad">No guardian responding</Tag>
                      )}
                      {s.isTest && <Tag className="sr-tag">TEST</Tag>}
                      <span className="sr-hint">
                        Started {formatTimeShort(s.startedAt)} · {TRIGGER[s.trigger] ?? s.trigger}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            ))}
        </SectionCard>
        <SectionCard title="Details">
          {selected ? (
            <SosDetails id={selected} onGone={() => setSelected(null)} />
          ) : (
            <EmptyState
              icon="list"
              title="Select an SOS"
              text="Its live map, guardians and alert status will show here."
            />
          )}
        </SectionCard>
      </div>
      <SectionCard title="Guardians for the selected SOS">
        {selected ? <SelectedGuardians id={selected} /> : <GuardianTable guardians={[]} />}
      </SectionCard>
    </>
  );
}

/** The open SOS, refreshed every 5 seconds (one shared request for details and guardians). */
function useLiveSos(id: string) {
  return useQuery({
    queryKey: ['live', id],
    queryFn: () => api<Details>(`/admin/live/${id}`),
    refetchInterval: (q) => (q.state.data?.ended ? false : REFRESH_MS),
  });
}

function SelectedGuardians({ id }: { id: string }) {
  const details = useLiveSos(id);
  const guardians = details.data && !details.data.ended ? details.data.guardians : [];
  return <GuardianTable guardians={guardians} />;
}

function SosDetails({ id, onGone }: { id: string; onGone: () => void }) {
  const details = useLiveSos(id);
  if (details.isPending) return <LoadingState />;
  if (details.isError) {
    if (details.error instanceof ApiError && details.error.status === 404) {
      onGone();
      return null;
    }
    return <ErrorState onRetry={() => void details.refetch()} />;
  }
  const d = details.data;
  if (d.ended) {
    const state: HistoryLinkState = { open: { type: 'sos', id: d.id } };
    return (
      <div className="sr-empty">
        <b>
          {d.outcome === 'cancelled'
            ? 'This SOS was cancelled in the countdown'
            : 'This SOS ended: user safe'}
        </b>
        <p>
          Live details are only shown while an SOS is active.{' '}
          <Link to="/history" state={state}>
            See it in History
          </Link>
        </p>
      </div>
    );
  }

  const lastAge = d.lastLocation ? minutesSince(d.lastLocation.at) : null;
  const rows: [string, ReactNode][] = [
    [
      'User',
      d.user ? (
        <Link to={`/users/${d.user.id}`}>
          {d.user.name ?? 'User'} <span className="sr-mono">{d.user.phone}</span>
        </Link>
      ) : (
        <span className="sr-muted">Deleted user</span>
      ),
    ],
    ['Running for', <span className="sr-mono">{runningFor(d.startedAt)}</span>],
    ['How it started', TRIGGER[d.trigger] ?? d.trigger],
    [
      'Last location',
      d.lostContact ? (
        <span className="sr-urgent">
          Lost contact: {d.lastLocation ? `no location for ${lastAge} min` : 'no location yet'}
        </span>
      ) : d.lastLocation ? (
        <span>
          {lastAge === 0 ? 'Just now' : `${lastAge} min ago`}
          {d.lastLocation.accuracyM !== null &&
            `, accurate to ${Math.round(d.lastLocation.accuracyM)} m`}
        </span>
      ) : (
        <span className="sr-muted">No location yet</span>
      ),
    ],
    ['Battery', <span className="sr-mono">{d.battery !== null ? `${d.battery}%` : '—'}</span>],
    ['Network', d.network ?? '—'],
    [
      'Audio',
      <span>
        {d.audio.clips > 0
          ? `Recording: ${d.audio.clips} clip${d.audio.clips === 1 ? '' : 's'} saved`
          : 'No audio yet'}
        <span className="sr-hint"> · Audio cannot be played here</span>
      </span>,
    ],
  ];
  return (
    <>
      {d.isTest && <Tag className="sr-tag">TEST</Tag>}
      <div className="sr-status-list">
        {rows.map(([label, value]) => (
          <div className="sr-status-row" key={label}>
            <span>{label}</span>
            {value}
          </div>
        ))}
      </div>
      <p className="sr-hint">
        The live map appears here once Google Maps is set up. Location is shown only while the SOS
        is active.
      </p>
    </>
  );
}

function GuardianTable({ guardians }: { guardians: LiveGuardian[] }) {
  return (
    <Table
      className="sr-table"
      rowKey="label"
      pagination={false}
      dataSource={guardians}
      columns={[
        { title: 'Guardian', key: 'g', render: (_: unknown, g: LiveGuardian) => g.label },
        {
          title: 'SMS',
          key: 'sms',
          render: (_: unknown, g: LiveGuardian) => <StatusBadge value={g.sms} />,
        },
        {
          title: 'Push',
          key: 'push',
          render: (_: unknown, g: LiveGuardian) => <StatusBadge value={g.push} />,
        },
        {
          title: 'Opened link',
          key: 'opened',
          render: (_: unknown, g: LiveGuardian) => (
            <span className="sr-mono">{g.openedAt ? formatTimeShort(g.openedAt) : '—'}</span>
          ),
        },
        {
          title: 'Responding',
          key: 'responding',
          render: (_: unknown, g: LiveGuardian) =>
            g.respondingAt ? (
              <span className="sr-badge ok">Responding · {formatTimeShort(g.respondingAt)}</span>
            ) : (
              <span className="sr-muted">—</span>
            ),
        },
      ]}
      locale={{
        emptyText: (
          <EmptyState
            icon="user"
            title="No SOS selected"
            text="Guardian alert status appears when an SOS is selected."
          />
        ),
      }}
    />
  );
}
