import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Button, DatePicker, Descriptions, Drawer, Select, Table, Tag } from 'antd';
import { useState } from 'react';
import { api } from '../api';
import { EmptyState, ErrorState, LoadingState, SectionCard } from '../components/states';
import { formatTimeExact } from '../format';
import { adminLabel, describe, flagOf, KIND_TAG, type AuditEntry } from './auditText';

interface TeamMember {
  id: string;
  name: string;
  removed: boolean;
}

type Kind = 'all' | 'changes' | 'logins';

interface Filters {
  admin?: string;
  kind: Kind;
  from?: string;
  to?: string;
}

function queryString(filters: Filters, before?: string): string {
  const params = new URLSearchParams({ kind: filters.kind });
  if (filters.admin) params.set('admin', filters.admin);
  if (filters.from) params.set('from', filters.from);
  if (filters.to) params.set('to', filters.to);
  if (before) params.set('before', before);
  return params.toString();
}

export function AuditBody() {
  const [filters, setFilters] = useState<Filters>({ kind: 'all' });
  const [open, setOpen] = useState<AuditEntry | null>(null);

  // The Admin filter lists everyone, removed admins too, so their history can be checked.
  const admins = useQuery({
    queryKey: ['admins'],
    queryFn: () => api<TeamMember[]>('/admin/admins'),
  });
  const log = useInfiniteQuery({
    queryKey: ['audit', filters],
    queryFn: ({ pageParam }) =>
      api<{ entries: AuditEntry[]; more: boolean }>(
        `/admin/audit?${queryString(filters, pageParam)}`,
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => (last.more ? last.entries[last.entries.length - 1]?.id : undefined),
  });

  const entries = log.data?.pages.flatMap((p) => p.entries) ?? [];
  const filtered = Boolean(filters.admin || filters.from || filters.kind !== 'all');

  const columns = [
    {
      title: 'When',
      key: 'when',
      render: (_: unknown, e: AuditEntry) => (
        <span className="sr-mono">{formatTimeExact(e.at)}</span>
      ),
    },
    { title: 'Admin', key: 'admin', render: (_: unknown, e: AuditEntry) => adminLabel(e) },
    {
      title: 'Action',
      key: 'action',
      render: (_: unknown, e: AuditEntry) => {
        const flag = flagOf(e);
        return (
          <span className="sr-tags">
            <Tag className="sr-tag">{KIND_TAG[e.kind]}</Tag>
            {flag && <Tag className="sr-tag sr-tag-bad">{flag}</Tag>}
          </span>
        );
      },
    },
    { title: 'What', key: 'what', render: (_: unknown, e: AuditEntry) => describe(e) },
    {
      title: 'IP address',
      key: 'ip',
      render: (_: unknown, e: AuditEntry) => <span className="sr-mono">{e.ip ?? '—'}</span>,
    },
    {
      title: '',
      key: 'details',
      render: (_: unknown, e: AuditEntry) => (
        <Button type="link" className="sr-link-left" onClick={() => setOpen(e)}>
          Details
        </Button>
      ),
    },
  ];

  return (
    <>
      <SectionCard>
        <div className="sr-filters">
          <Select
            aria-label="Admin"
            value={filters.admin ?? ''}
            onChange={(admin: string) => setFilters({ ...filters, admin: admin || undefined })}
            options={[
              { value: '', label: 'All admins' },
              ...(admins.data ?? []).map((a) => ({
                value: a.id,
                label: a.removed ? `${a.name} (removed)` : a.name,
              })),
            ]}
          />
          <Select
            aria-label="Kind"
            value={filters.kind}
            onChange={(kind: Kind) => setFilters({ ...filters, kind })}
            options={[
              { value: 'all', label: 'Views and changes' },
              { value: 'changes', label: 'Changes only' },
              { value: 'logins', label: 'Logins only' },
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

        {log.isPending && <LoadingState />}
        {log.isError && <ErrorState onRetry={() => void log.refetch()} />}
        {log.isSuccess && (
          <>
            <Table
              className="sr-table"
              rowKey="id"
              columns={columns}
              dataSource={entries}
              pagination={false}
              scroll={{ x: 'max-content' }}
              locale={{
                emptyText: filtered ? (
                  <EmptyState
                    icon="list"
                    title="Nothing matches these filters"
                    text="Try another admin, kind or date range."
                  />
                ) : (
                  <EmptyState
                    icon="list"
                    title="No entries yet"
                    text="Every login, view and change in this panel is recorded here."
                  />
                ),
              }}
            />
            {log.hasNextPage && (
              <div className="sr-center">
                <Button onClick={() => void log.fetchNextPage()} loading={log.isFetchingNextPage}>
                  Load more
                </Button>
              </div>
            )}
          </>
        )}
      </SectionCard>

      <Drawer open={open !== null} onClose={() => setOpen(null)} title="Details" size={480}>
        {open && <EntryDetails entry={open} />}
      </Drawer>
    </>
  );
}

function EntryDetails({ entry }: { entry: AuditEntry }) {
  // Settings changes carry before/after values; other entries have no details.
  const details: { before?: unknown; after?: unknown } | null =
    typeof entry.details === 'object' ? entry.details : null;
  const flag = flagOf(entry);
  const items = [
    {
      key: 'when',
      label: 'When',
      children: <span className="sr-mono">{formatTimeExact(entry.at)}</span>,
    },
    { key: 'admin', label: 'Admin', children: adminLabel(entry) },
    {
      key: 'action',
      label: 'Action',
      children: `${KIND_TAG[entry.kind]}${flag ? ` · ${flag}` : ''}`,
    },
    { key: 'what', label: 'What', children: describe(entry) },
    ...(details && 'before' in details
      ? [
          {
            key: 'before',
            label: 'Before',
            children: <span className="sr-mono">{String(details.before)}</span>,
          },
          {
            key: 'after',
            label: 'After',
            children: <span className="sr-mono">{String(details.after)}</span>,
          },
        ]
      : []),
    ...(entry.reason ? [{ key: 'reason', label: 'Reason', children: entry.reason }] : []),
    {
      key: 'ip',
      label: 'IP address',
      children: <span className="sr-mono">{entry.ip ?? '—'}</span>,
    },
    {
      key: 'browser',
      label: 'Browser',
      children: <span className="sr-mono sr-break">{entry.userAgent ?? '—'}</span>,
    },
    ...(entry.statusCode
      ? [{ key: 'result', label: 'Result code', children: String(entry.statusCode) }]
      : []),
  ];
  return <Descriptions column={1} bordered size="small" items={items} />;
}
