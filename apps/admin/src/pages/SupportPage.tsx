import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Descriptions, Drawer, Select, Space, Table, Tag } from 'antd';
import { useState } from 'react';
import { api, ApiError } from '../api';
import { EmptyState, ErrorState, LoadingState, SectionCard } from '../components/states';
import { formatTimeShort } from '../format';

// Screen 6: Support Tickets — "Report a problem" from the app. Both admin roles. Status tags from
// the design: New, In progress, Resolved. The phone number is partly hidden and every view and
// change is written to the audit log (on the server). Replies to the user are not built yet.

type Status = 'open' | 'in_progress' | 'closed';

const STATUS_LABEL: Record<Status, string> = {
  open: 'New',
  in_progress: 'In progress',
  closed: 'Resolved',
};
const STATUS_COLOUR: Record<Status, string> = {
  open: 'gold',
  in_progress: 'blue',
  closed: 'green',
};

/** The four choices in the app's "Report a problem". */
const CATEGORY: Record<string, string> = {
  otp: 'OTP not received',
  guardian_sms: 'Guardian didn’t get SMS',
  app_stopped: 'App stopped working',
  other: 'Other',
};
const category = (c: string) => CATEGORY[c] ?? c;

interface TicketRow {
  id: string;
  category: string;
  preview: string;
  status: Status;
  userId: string;
  userName: string | null;
  userPhone: string;
  assignedTo: string | null;
  createdAt: string;
}

interface TicketDetail {
  id: string;
  category: string;
  message: string;
  status: Status;
  appVersion: string | null;
  deviceModel: string | null;
  createdAt: string;
  closedAt: string | null;
  assignedAdminId: string | null;
  assignedTo: string | null;
  user: { id: string; name: string | null; phone: string };
}

const errorText = (e: unknown) =>
  e instanceof ApiError
    ? (e.serverMessage ?? 'Something went wrong. Please try again.')
    : 'Something went wrong. Please try again.';

export function SupportBody() {
  const [status, setStatus] = useState<Status | 'all'>('all');
  const [open, setOpen] = useState<string | null>(null);
  const tickets = useQuery({
    queryKey: ['support-tickets', status],
    queryFn: () =>
      api<{ items: TicketRow[]; more: boolean; counts: Partial<Record<Status, number>> }>(
        `/admin/support-tickets${status === 'all' ? '' : `?status=${status}`}`,
      ),
  });
  const counts = tickets.data?.counts ?? {};
  const label = (s: Status) => (counts[s] ? `${STATUS_LABEL[s]} (${counts[s]})` : STATUS_LABEL[s]);
  return (
    <>
      <SectionCard>
        <div className="sr-filters">
          <Select
            aria-label="Status"
            value={status}
            onChange={(v) => setStatus(v)}
            style={{ minWidth: 200 }}
            options={[
              { value: 'all', label: 'All tickets' },
              { value: 'open', label: label('open') },
              { value: 'in_progress', label: label('in_progress') },
              { value: 'closed', label: label('closed') },
            ]}
          />
        </div>
        {tickets.isPending ? (
          <LoadingState />
        ) : tickets.isError ? (
          <ErrorState onRetry={() => void tickets.refetch()} />
        ) : (
          <Table
            className="sr-table"
            rowKey="id"
            dataSource={tickets.data.items}
            pagination={false}
            scroll={{ x: 'max-content' }}
            onRow={(r) => ({ onClick: () => setOpen(r.id), style: { cursor: 'pointer' } })}
            columns={[
              {
                title: 'Received',
                key: 'c',
                render: (_: unknown, r: TicketRow) => formatTimeShort(r.createdAt),
              },
              {
                title: 'User',
                key: 'u',
                render: (_: unknown, r: TicketRow) => (
                  <>
                    {r.userName ?? 'No name'}
                    <div className="sr-muted">{r.userPhone}</div>
                  </>
                ),
              },
              {
                title: 'Subject',
                key: 's',
                render: (_: unknown, r: TicketRow) => (
                  <>
                    {category(r.category)}
                    <div className="sr-muted">{r.preview}</div>
                  </>
                ),
              },
              {
                title: 'Status',
                key: 'st',
                render: (_: unknown, r: TicketRow) => (
                  <Tag color={STATUS_COLOUR[r.status]}>{STATUS_LABEL[r.status]}</Tag>
                ),
              },
              {
                title: 'Assigned to',
                key: 'a',
                render: (_: unknown, r: TicketRow) => r.assignedTo ?? '—',
              },
              { title: '', key: 'o', render: () => <Button size="small">Open</Button> },
            ]}
            locale={{
              emptyText: (
                <EmptyState
                  icon="inbox"
                  title={
                    status === 'all'
                      ? 'No tickets yet'
                      : `No ${STATUS_LABEL[status].toLowerCase()} tickets`
                  }
                  text="When a user taps “Report a problem” in the app, the ticket appears here."
                />
              ),
            }}
          />
        )}
        {tickets.data?.more && (
          <p className="sr-muted" style={{ padding: 12 }}>
            Showing the newest 50. Choose a status to narrow the list.
          </p>
        )}
      </SectionCard>
      {open && <TicketDrawer id={open} onClose={() => setOpen(null)} />}
    </>
  );
}

function TicketDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient();
  const ticket = useQuery({
    queryKey: ['support-ticket', id],
    queryFn: () => api<TicketDetail>(`/admin/support-tickets/${id}`),
  });
  const act = useMutation({
    mutationFn: (v: { path: 'status' | 'assign'; body: object }) =>
      api<TicketDetail>(`/admin/support-tickets/${id}/${v.path}`, { method: 'POST', body: v.body }),
    onSuccess: (data) => {
      qc.setQueryData(['support-ticket', id], data);
      void qc.invalidateQueries({ queryKey: ['support-tickets'] });
    },
  });
  const t = ticket.data;
  const setStatus = (status: Status) => act.mutate({ path: 'status', body: { status } });
  return (
    <Drawer
      open
      width={560}
      title="Support ticket"
      onClose={onClose}
      extra={
        t && (
          <Space wrap>
            {t.assignedTo ? (
              <Button
                loading={act.isPending}
                onClick={() => act.mutate({ path: 'assign', body: { toMe: false } })}
              >
                Unassign
              </Button>
            ) : (
              <Button
                loading={act.isPending}
                onClick={() => act.mutate({ path: 'assign', body: { toMe: true } })}
              >
                Assign to me
              </Button>
            )}
            {t.status === 'open' && (
              <Button loading={act.isPending} onClick={() => setStatus('in_progress')}>
                Mark in progress
              </Button>
            )}
            {t.status === 'closed' ? (
              <Button loading={act.isPending} onClick={() => setStatus('open')}>
                Reopen
              </Button>
            ) : (
              <Button type="primary" loading={act.isPending} onClick={() => setStatus('closed')}>
                Mark resolved
              </Button>
            )}
          </Space>
        )
      }
    >
      {ticket.isPending ? (
        <LoadingState />
      ) : ticket.isError || !t ? (
        <ErrorState onRetry={() => void ticket.refetch()} />
      ) : (
        <>
          {act.isError && (
            <Alert
              type="error"
              showIcon
              message={errorText(act.error)}
              style={{ marginBottom: 12 }}
            />
          )}
          <Descriptions column={1} bordered size="small">
            <Descriptions.Item label="Problem">{category(t.category)}</Descriptions.Item>
            <Descriptions.Item label="Status">
              <Tag color={STATUS_COLOUR[t.status]}>{STATUS_LABEL[t.status]}</Tag>
              {t.closedAt ? ` ${formatTimeShort(t.closedAt)}` : ''}
            </Descriptions.Item>
            <Descriptions.Item label="User">
              {t.user.name ?? 'No name'} · {t.user.phone}
            </Descriptions.Item>
            <Descriptions.Item label="Phone">
              {[t.deviceModel, t.appVersion && `app ${t.appVersion}`].filter(Boolean).join(' · ') ||
                '—'}
            </Descriptions.Item>
            <Descriptions.Item label="Assigned to">{t.assignedTo ?? '—'}</Descriptions.Item>
            <Descriptions.Item label="Received">{formatTimeShort(t.createdAt)}</Descriptions.Item>
          </Descriptions>
          <h4 style={{ marginTop: 20 }}>Message</h4>
          <p style={{ whiteSpace: 'pre-wrap' }}>{t.message}</p>
          <Alert
            type="info"
            showIcon
            style={{ marginTop: 16 }}
            message="Replying from here is not available yet: the app cannot show replies. Support is for office hours only, not for emergencies."
          />
        </>
      )}
    </Drawer>
  );
}
