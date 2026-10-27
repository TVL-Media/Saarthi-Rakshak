import { useInfiniteQuery } from '@tanstack/react-query';
import { Button, Input, Select, Table } from 'antd';
import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { ApiError, post } from '../api';
import { EmptyState, ErrorState, LoadingState, SectionCard } from '../components/states';
import { formatTime } from '../format';

export interface UserRow {
  id: string;
  name: string | null;
  /** Always masked by the server, e.g. "+91 98•• ••4521". */
  phone: string | null;
  setupComplete: boolean;
  guardiansAccepted: number;
  guardiansTotal: number;
  appVersion: string | null;
  lastSeenAt: string | null;
  status: 'active' | 'blocked';
}

/** Router state to open the list with a filter (e.g. setup unfinished). */
export interface UsersLinkState {
  filter?: Search;
}

interface Search {
  phone?: string;
  setup?: 'complete' | 'unfinished';
  status?: 'active' | 'blocked';
}

export function UsersBody() {
  const navigate = useNavigate();
  const location = useLocation();
  const [typed, setTyped] = useState('');
  // The Dashboard links here with a filter already chosen (router state, memory only).
  const [search, setSearch] = useState<Search>(
    () => (location.state as UsersLinkState | null)?.filter ?? {},
  );

  // POST: the phone number never goes into the web address or browser history.
  const users = useInfiniteQuery({
    queryKey: ['users', search],
    queryFn: ({ pageParam }) =>
      post<{ users: UserRow[]; more: boolean }>('/admin/users/search', {
        ...search,
        after: pageParam,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => (last.more ? last.users[last.users.length - 1]?.id : undefined),
  });

  const searchError =
    users.error instanceof ApiError && users.error.status === 400
      ? users.error.serverMessage
      : undefined;
  const rows = users.data?.pages.flatMap((p) => p.users) ?? [];
  const filtered = Boolean(search.phone || search.setup || search.status);

  const columns = [
    { title: 'Name', key: 'name', render: (_: unknown, u: UserRow) => u.name ?? '—' },
    {
      title: 'Phone',
      key: 'phone',
      render: (_: unknown, u: UserRow) => <span className="sr-mono">{u.phone}</span>,
    },
    {
      title: 'Setup',
      key: 'setup',
      render: (_: unknown, u: UserRow) =>
        u.setupComplete ? (
          <span className="sr-badge ok">Complete</span>
        ) : (
          <span className="sr-badge warn">Unfinished</span>
        ),
    },
    {
      title: 'Guardians',
      key: 'guardians',
      render: (_: unknown, u: UserRow) => (
        <span className="sr-mono">
          {u.guardiansAccepted} / {u.guardiansTotal}
        </span>
      ),
    },
    {
      title: 'App version',
      key: 'app',
      render: (_: unknown, u: UserRow) => <span className="sr-mono">{u.appVersion ?? '—'}</span>,
    },
    {
      title: 'Last seen',
      key: 'seen',
      render: (_: unknown, u: UserRow) => (
        <span className="sr-mono">{formatTime(u.lastSeenAt)}</span>
      ),
    },
    {
      title: 'Status',
      key: 'status',
      render: (_: unknown, u: UserRow) =>
        u.status === 'blocked' ? (
          <span className="sr-badge bad">Blocked</span>
        ) : (
          <span className="sr-badge ok">Active</span>
        ),
    },
  ];

  return (
    <SectionCard>
      <form
        className="sr-filters"
        onSubmit={(e) => {
          e.preventDefault();
          setSearch({ ...search, phone: typed.trim() || undefined });
        }}
      >
        <Input.Search
          aria-label="Search by phone number"
          placeholder="Phone number, e.g. 98xxxxxx21"
          inputMode="tel"
          allowClear
          value={typed}
          onChange={(e) => {
            setTyped(e.target.value);
            if (!e.target.value) setSearch({ ...search, phone: undefined });
          }}
          onSearch={(value) => setSearch({ ...search, phone: value.trim() || undefined })}
          status={searchError ? 'error' : undefined}
        />
        <Select
          aria-label="Setup status"
          value={search.setup ?? ''}
          onChange={(setup: string) =>
            setSearch({ ...search, setup: (setup || undefined) as Search['setup'] })
          }
          options={[
            { value: '', label: 'Any setup status' },
            { value: 'complete', label: 'Setup complete' },
            { value: 'unfinished', label: 'Setup unfinished' },
          ]}
        />
        <Select
          aria-label="Account status"
          value={search.status ?? ''}
          onChange={(status: string) =>
            setSearch({ ...search, status: (status || undefined) as Search['status'] })
          }
          options={[
            { value: '', label: 'Any account status' },
            { value: 'active', label: 'Active' },
            { value: 'blocked', label: 'Blocked' },
          ]}
        />
      </form>
      {searchError && (
        <span className="sr-err-text" role="alert">
          {searchError}
        </span>
      )}

      {users.isPending && <LoadingState />}
      {users.isError && !searchError && <ErrorState onRetry={() => void users.refetch()} />}
      {users.isSuccess && (
        <>
          <Table
            className="sr-table sr-table-clickable"
            rowKey="id"
            columns={columns}
            dataSource={rows}
            pagination={false}
            scroll={{ x: 'max-content' }}
            onRow={(u) => ({ onClick: () => void navigate(`/users/${u.id}`) })}
            locale={{
              emptyText: filtered ? (
                <EmptyState
                  icon="user"
                  title="No user matches"
                  text="Check the number (all 10 digits) or change the filters."
                />
              ) : (
                <EmptyState
                  icon="user"
                  title="No users yet"
                  text="Users appear here after they sign up in the app."
                />
              ),
            }}
          />
          {users.hasNextPage && (
            <div className="sr-center">
              <Button onClick={() => void users.fetchNextPage()} loading={users.isFetchingNextPage}>
                Load more
              </Button>
            </div>
          )}
        </>
      )}
    </SectionCard>
  );
}
