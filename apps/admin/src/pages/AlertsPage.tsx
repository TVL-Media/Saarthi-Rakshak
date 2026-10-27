import { useInfiniteQuery } from '@tanstack/react-query';
import { Button, Drawer, Table, Tag } from 'antd';
import { useState } from 'react';
import { api } from '../api';
import { EmptyState, ErrorState, LoadingState, SectionCard } from '../components/states';
import { formatTimeExact, formatTimeShort } from '../format';
import { TimelineView } from './HistoryPage';

type NextStep =
  | 'sending'
  | 'awaiting_report'
  | 'none'
  | 'retry_backup'
  | 'retrying'
  | 'all_failed'
  | 'sent_again'
  | 'sms_sent_too'
  | 'no_sms_yet';

interface AlertRow {
  id: string;
  cursor: string;
  at: string;
  channel: 'sms' | 'push' | 'sim_sms';
  provider: 'main' | 'backup' | null;
  result: 'queued' | 'sent' | 'delivered' | 'failed';
  attempt: number;
  maxAttempts: number;
  to: string;
  about: { type: 'sos' | 'journey'; id: string } | null;
  stillFailed: boolean;
  nextStep: NextStep;
}

interface Counts {
  sentToday: number;
  deliveredToday: number;
  failedToday: number;
  backupToday: number;
}

const CHANNEL: Record<AlertRow['channel'], string> = {
  sms: 'SMS',
  push: 'Push',
  sim_sms: 'SMS from the phone',
};

const RESULT: Record<AlertRow['result'], { label: string; tone: string }> = {
  queued: { label: 'Waiting', tone: 'off' },
  sent: { label: 'Sent', tone: 'ok' },
  delivered: { label: 'Delivered', tone: 'ok' },
  failed: { label: 'Failed', tone: 'bad' },
};

/** "Next step" in words. Red only when nothing more will be tried. */
function nextStepText(row: AlertRow): { text: string; urgent?: boolean } {
  switch (row.nextStep) {
    case 'sending':
      return { text: 'Sending now' };
    case 'awaiting_report':
      return { text: 'Waiting for delivery report' };
    case 'retry_backup':
      return { text: 'Retry with backup provider' };
    case 'retrying':
      return { text: `Retrying (try ${row.attempt + 1} of ${row.maxAttempts})` };
    case 'all_failed':
      return { text: 'All tries failed. Check provider status.', urgent: true };
    case 'sent_again':
      return { text: 'Sent again (see newer row)' };
    case 'sms_sent_too':
      return { text: 'SMS was sent too' };
    case 'no_sms_yet':
      return { text: 'No SMS has reached this guardian yet', urgent: true };
    default:
      return { text: '—' };
  }
}

function Stat({ label, value, sos }: { label: string; value: number | undefined; sos?: boolean }) {
  return (
    <SectionCard>
      <div className={sos ? 'sr-stat sos' : 'sr-stat'}>
        <span>{label}</span>
        <b>{value ?? 0}</b>
      </div>
    </SectionCard>
  );
}

function SetupRow({ label }: { label: string }) {
  return (
    <div className="sr-status-row">
      <span>{label}</span>
      <span className="sr-badge off">Not set up</span>
    </div>
  );
}

export function AlertsBody() {
  const [open, setOpen] = useState<{ type: 'sos' | 'journey'; id: string } | null>(null);
  const alerts = useInfiniteQuery({
    queryKey: ['alerts'],
    queryFn: ({ pageParam }) =>
      api<{ rows: AlertRow[]; more: boolean; counts: Counts | null }>(
        `/admin/alerts${pageParam ? `?before=${encodeURIComponent(pageParam)}` : ''}`,
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => (last.more ? last.rows[last.rows.length - 1]?.cursor : undefined),
  });

  if (alerts.isPending) return <LoadingState />;
  if (alerts.isError) return <ErrorState onRetry={() => void alerts.refetch()} />;

  const counts = alerts.data.pages[0]?.counts ?? undefined;
  const rows = alerts.data.pages.flatMap((p) => p.rows);

  const columns = [
    {
      title: 'Time',
      key: 'time',
      render: (_: unknown, r: AlertRow) => (
        <span className="sr-mono" title={formatTimeExact(r.at)}>
          {formatTimeShort(r.at)}
        </span>
      ),
    },
    { title: 'Channel', key: 'channel', render: (_: unknown, r: AlertRow) => CHANNEL[r.channel] },
    {
      title: 'Provider',
      key: 'provider',
      render: (_: unknown, r: AlertRow) =>
        r.provider === 'main' ? 'Main' : r.provider === 'backup' ? 'Backup' : '—',
    },
    {
      title: 'To',
      key: 'to',
      render: (_: unknown, r: AlertRow) => (
        <span className="sr-tags">
          <span>{r.to}</span>
          <Tag className="sr-tag">
            {r.about ? (r.about.type === 'sos' ? 'SOS' : 'Journey') : 'Deleted'}
          </Tag>
        </span>
      ),
    },
    {
      title: 'Result',
      key: 'result',
      render: (_: unknown, r: AlertRow) => (
        <span className={`sr-badge ${RESULT[r.result].tone}`}>{RESULT[r.result].label}</span>
      ),
    },
    {
      title: 'Next step',
      key: 'next',
      render: (_: unknown, r: AlertRow) => {
        const next = nextStepText(r);
        return (
          <span className={next.urgent ? 'sr-err-text sr-strong' : undefined}>{next.text}</span>
        );
      },
    },
  ];

  return (
    <>
      <div className="sr-stat-grid">
        <Stat label="Sent today" value={counts?.sentToday} />
        <Stat label="Delivered" value={counts?.deliveredToday} />
        <Stat label="Failed" value={counts?.failedToday} sos />
        <Stat label="Sent by backup provider" value={counts?.backupToday} />
      </div>
      <div className="sr-cols">
        <SectionCard title="Messages">
          <Table
            className="sr-table sr-table-clickable"
            rowKey="id"
            columns={columns}
            dataSource={rows}
            pagination={false}
            // No sideways scrolling: long text wraps, so "Next step" stays visible.
            rowClassName={(r) => (r.stillFailed ? 'sr-row-failed' : '')}
            onRow={(r) => ({ onClick: () => r.about && setOpen(r.about) })}
            locale={{
              emptyText: (
                <EmptyState
                  icon="inbox"
                  title="No alerts sent yet"
                  text="Every SMS and push sent for an SOS, check-in or lost contact will be logged here."
                />
              ),
            }}
          />
          {alerts.hasNextPage && (
            <div className="sr-center">
              <Button
                onClick={() => void alerts.fetchNextPage()}
                loading={alerts.isFetchingNextPage}
              >
                Load more
              </Button>
            </div>
          )}
        </SectionCard>
        <SectionCard title="SMS setup">
          <div className="sr-status-list">
            <SetupRow label="DLT templates" />
            <SetupRow label="Link domain" />
            <SetupRow label="Main provider" />
            <SetupRow label="Backup provider" />
          </div>
        </SectionCard>
      </div>

      <Drawer open={open !== null} onClose={() => setOpen(null)} title="Timeline" size={560}>
        {open && (
          <TimelineView
            key={`${open.type}:${open.id}`}
            type={open.type}
            id={open.id}
            onOpenSos={(id) => setOpen({ type: 'sos', id })}
          />
        )}
      </Drawer>
    </>
  );
}
