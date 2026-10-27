import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Button, DatePicker, Drawer, Select, Table, Tag, Timeline } from 'antd';
import { useState } from 'react';
import { Link } from 'react-router';
import { api } from '../api';
import { EmptyState, ErrorState, LoadingState, SectionCard } from '../components/states';
import { formatTime, formatTimeExact } from '../format';

type Outcome =
  'active' | 'ended_safe' | 'cancelled' | 'arrived' | 'ended' | 'lost_contact' | 'turned_into_sos';

interface HistoryRow {
  type: 'sos' | 'journey';
  id: string;
  cursor: string;
  startedAt: string;
  endedAt: string | null;
  isTest: boolean;
  trigger: string | null;
  user: { id: string; name: string | null; phone: string | null } | null;
  userDeleted: boolean;
  guardiansAlerted: number;
  outcome: Outcome;
  sosId: string | null;
}

interface TimelineEvent {
  at: string;
  kind: string;
  text: string;
  warning?: boolean;
}

const OUTCOME: Record<Outcome, string> = {
  active: 'Still active',
  ended_safe: 'Ended safe',
  cancelled: 'Cancelled in countdown',
  arrived: 'Arrived safely',
  ended: 'Ended',
  lost_contact: 'Lost contact',
  turned_into_sos: 'Turned into SOS',
};

const TRIGGER: Record<string, string> = {
  button: 'SOS button',
  widget: 'Widget',
  tile: 'Quick tile',
  checkin: 'Check-in',
  journey: 'Journey',
};

interface Filters {
  type: 'all' | 'sos' | 'journey';
  real: 'all' | 'real' | 'test';
  outcome?: Outcome;
  from?: string;
  to?: string;
}

/** e.g. "12 min", "1 h 5 min"; "—" while still running. */
function duration(row: HistoryRow): string {
  if (!row.endedAt) return '—';
  const minutes = Math.max(
    0,
    Math.round((Date.parse(row.endedAt) - Date.parse(row.startedAt)) / 60_000),
  );
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/** Who: SOS rows name the user (masked phone); journey rows never do (rule 6). */
function UserCell({ row }: { row: HistoryRow }) {
  if (row.type === 'journey') return <span className="sr-muted">A user's journey</span>;
  if (row.userDeleted || !row.user) return <span className="sr-muted">Deleted user</span>;
  return (
    <Link to={`/users/${row.user.id}`} onClick={(e) => e.stopPropagation()}>
      {row.user.name ?? 'User'} <span className="sr-mono">{row.user.phone}</span>
    </Link>
  );
}

function OutcomeCell({ row, onOpenSos }: { row: HistoryRow; onOpenSos: (id: string) => void }) {
  if (row.outcome === 'active') {
    return (
      <Link to="/live" onClick={(e) => e.stopPropagation()} className="sr-badge bad">
        {OUTCOME.active}
      </Link>
    );
  }
  if (row.outcome === 'turned_into_sos' && row.sosId) {
    const sosId = row.sosId;
    return (
      <Button
        type="link"
        className="sr-link-left"
        onClick={(e) => {
          e.stopPropagation();
          onOpenSos(sosId);
        }}
      >
        {OUTCOME.turned_into_sos}
      </Button>
    );
  }
  const tone = row.outcome === 'lost_contact' ? 'warn' : row.outcome === 'cancelled' ? 'off' : 'ok';
  return <span className={`sr-badge ${tone}`}>{OUTCOME[row.outcome]}</span>;
}

export function HistoryBody() {
  const [filters, setFilters] = useState<Filters>({ type: 'all', real: 'all' });
  const [open, setOpen] = useState<{ type: 'sos' | 'journey'; id: string } | null>(null);

  const history = useInfiniteQuery({
    queryKey: ['history', filters],
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ type: filters.type, real: filters.real });
      if (filters.outcome) params.set('outcome', filters.outcome);
      if (filters.from) params.set('from', filters.from);
      if (filters.to) params.set('to', filters.to);
      if (pageParam) params.set('before', pageParam);
      return api<{ rows: HistoryRow[]; more: boolean }>(`/admin/history?${params.toString()}`);
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => (last.more ? last.rows[last.rows.length - 1]?.cursor : undefined),
  });
  const rows = history.data?.pages.flatMap((p) => p.rows) ?? [];
  const filtered =
    filters.type !== 'all' || filters.real !== 'all' || Boolean(filters.outcome || filters.from);
  const openSos = (id: string) => setOpen({ type: 'sos', id });

  const columns = [
    {
      title: 'Started',
      key: 'started',
      render: (_: unknown, r: HistoryRow) => (
        <span className="sr-mono">{formatTime(r.startedAt)}</span>
      ),
    },
    {
      title: 'Type',
      key: 'type',
      render: (_: unknown, r: HistoryRow) => (
        <span className="sr-tags">
          {r.type === 'sos' ? 'SOS' : 'Journey'}
          {r.isTest && <Tag className="sr-tag">TEST</Tag>}
        </span>
      ),
    },
    { title: 'User', key: 'user', render: (_: unknown, r: HistoryRow) => <UserCell row={r} /> },
    {
      title: 'Duration',
      key: 'duration',
      render: (_: unknown, r: HistoryRow) => <span className="sr-mono">{duration(r)}</span>,
    },
    {
      title: 'Started by',
      key: 'trigger',
      render: (_: unknown, r: HistoryRow) => (r.trigger ? (TRIGGER[r.trigger] ?? r.trigger) : '—'),
    },
    {
      title: 'Guardians alerted',
      key: 'alerted',
      render: (_: unknown, r: HistoryRow) => <span className="sr-mono">{r.guardiansAlerted}</span>,
    },
    {
      title: 'Outcome',
      key: 'outcome',
      render: (_: unknown, r: HistoryRow) => <OutcomeCell row={r} onOpenSos={openSos} />,
    },
  ];

  return (
    <>
      <SectionCard>
        <div className="sr-filters">
          <Select
            aria-label="Type"
            value={filters.type}
            onChange={(type: Filters['type']) => setFilters({ ...filters, type })}
            options={[
              { value: 'all', label: 'SOS and journeys' },
              { value: 'sos', label: 'SOS only' },
              { value: 'journey', label: 'Journeys only' },
            ]}
          />
          <Select
            aria-label="Real or test"
            value={filters.real}
            onChange={(real: Filters['real']) => setFilters({ ...filters, real })}
            options={[
              { value: 'all', label: 'Real and test' },
              { value: 'real', label: 'Real only' },
              { value: 'test', label: 'Test only' },
            ]}
          />
          <Select
            aria-label="Outcome"
            value={filters.outcome ?? ''}
            onChange={(outcome: string) =>
              setFilters({ ...filters, outcome: (outcome || undefined) as Outcome | undefined })
            }
            options={[
              { value: '', label: 'Any outcome' },
              ...(Object.keys(OUTCOME) as Outcome[]).map((o) => ({ value: o, label: OUTCOME[o] })),
            ]}
          />
          <DatePicker.RangePicker
            aria-label="Date range"
            placeholder={['From', 'To']}
            format="YYYY-MM-DD"
            onChange={(_dates, [from, to]) =>
              setFilters({ ...filters, from: from || undefined, to: to || undefined })
            }
          />
        </div>

        {history.isPending && <LoadingState />}
        {history.isError && <ErrorState onRetry={() => void history.refetch()} />}
        {history.isSuccess && (
          <>
            <Table
              className="sr-table sr-table-clickable"
              rowKey={(r) => `${r.type}:${r.id}`}
              columns={columns}
              dataSource={rows}
              pagination={false}
              scroll={{ x: 'max-content' }}
              onRow={(r) => ({ onClick: () => setOpen({ type: r.type, id: r.id }) })}
              locale={{
                emptyText: filtered ? (
                  <EmptyState
                    icon="list"
                    title="Nothing matches these filters"
                    text="Try another type, outcome or date range."
                  />
                ) : (
                  <EmptyState
                    icon="list"
                    title="No SOS or journeys yet"
                    text="Every SOS and journey from the app will be listed here with its full timeline."
                  />
                ),
              }}
            />
            {history.hasNextPage && (
              <div className="sr-center">
                <Button
                  onClick={() => void history.fetchNextPage()}
                  loading={history.isFetchingNextPage}
                >
                  Load more
                </Button>
              </div>
            )}
          </>
        )}
      </SectionCard>

      <Drawer open={open !== null} onClose={() => setOpen(null)} title="Timeline" size={560}>
        {open && (
          <TimelineView
            key={`${open.type}:${open.id}`}
            type={open.type}
            id={open.id}
            onOpenSos={openSos}
          />
        )}
      </Drawer>
    </>
  );
}

export function TimelineView(props: {
  type: 'sos' | 'journey';
  id: string;
  onOpenSos: (id: string) => void;
}) {
  const timeline = useQuery({
    queryKey: ['timeline', props.type, props.id],
    queryFn: () =>
      api<{ row: HistoryRow; events: TimelineEvent[] }>(`/admin/history/${props.type}/${props.id}`),
  });
  if (timeline.isPending) return <LoadingState />;
  if (timeline.isError) return <ErrorState onRetry={() => void timeline.refetch()} />;
  const { row, events } = timeline.data;
  return (
    <div className="sr-modal-body">
      <div className="sr-status-list">
        <div className="sr-status-row">
          <span>Type</span>
          <span className="sr-tags">
            {row.type === 'sos' ? 'SOS' : 'Journey'}
            {row.isTest && <Tag className="sr-tag">TEST</Tag>}
          </span>
        </div>
        <div className="sr-status-row">
          <span>User</span>
          <UserCell row={row} />
        </div>
        <div className="sr-status-row">
          <span>Duration</span>
          <span className="sr-mono">{duration(row)}</span>
        </div>
        <div className="sr-status-row">
          <span>Outcome</span>
          <OutcomeCell row={row} onOpenSos={props.onOpenSos} />
        </div>
      </div>
      <p className="sr-hint">Read only. Location is shown only as gaps, never on a map.</p>
      <Timeline
        items={events.map((e, i) => ({
          key: i,
          color: e.warning ? 'red' : 'blue',
          children: (
            <div>
              <div className="sr-mono sr-hint">{formatTimeExact(e.at)}</div>
              <div className={e.warning ? 'sr-err-text sr-timeline-text' : 'sr-timeline-text'}>
                {e.text}
              </div>
            </div>
          ),
        }))}
      />
    </div>
  );
}
