import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Button,
  Descriptions,
  Drawer,
  Input,
  InputNumber,
  Modal,
  Segmented,
  Select,
  Space,
  Table,
  Tag,
} from 'antd';
import { useState } from 'react';
import { api, ApiError } from '../api';
import { useMe } from '../auth/session';
import { EmptyState, ErrorState, LoadingState, SectionCard } from '../components/states';
import { formatTimeShort } from '../format';

// Phase 3 admin screen: Bookings (customer side). A booking moves forward by hand for now: send a
// quote, assign an approved Rakshak, mark started / completed, or cancel with a reason. Admins see
// the place label only, never the exact position, and the phone number is masked. There is no
// Rakshak app yet, so nobody else moves a booking.

type Status =
  'requested' | 'quoted' | 'confirmed' | 'assigned' | 'in_progress' | 'completed' | 'cancelled';

const STATUS_LABEL: Record<Status, string> = {
  requested: 'Requested',
  quoted: 'Quoted',
  confirmed: 'Confirmed',
  assigned: 'Assigned',
  in_progress: 'In progress',
  completed: 'Completed',
  cancelled: 'Cancelled',
};
const STATUS_COLOUR: Record<Status, string> = {
  requested: 'gold',
  quoted: 'blue',
  confirmed: 'cyan',
  assigned: 'purple',
  in_progress: 'geekblue',
  completed: 'green',
  cancelled: 'default',
};
const ACTOR: Record<string, string> = {
  user: 'The user',
  rakshak: 'The Rakshak',
  admin: 'An admin',
  system: 'The system',
};

interface BookingRow {
  id: string;
  serviceName: string;
  status: Status;
  windowStart: string;
  windowEnd: string;
  placeLabel: string | null;
  quoteAmountPaise: number | null;
  userId: string;
  userName: string | null;
  userPhone: string;
  rakshakName: string | null;
  createdAt: string;
}

interface BookingDetail {
  id: string;
  serviceName: string;
  status: Status;
  windowStart: string;
  windowEnd: string;
  placeLabel: string | null;
  notes: string | null;
  quote: { amountPaise: number; note: string | null; expiresAt: string | null } | null;
  rakshak: { firstName: string } | null;
  cancelReason: string | null;
  history: { status: string; at: string; by: string }[];
  user: { id: string; name: string | null; phone: string };
  createdAt: string;
}

const errorText = (e: unknown) =>
  e instanceof ApiError
    ? (e.serverMessage ?? 'Something went wrong. Please try again.')
    : 'Something went wrong. Please try again.';

const rupees = (paise: number) =>
  `₹${(paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

export function BookingsBody() {
  const [status, setStatus] = useState<Status | 'all'>('requested');
  const [open, setOpen] = useState<string | null>(null);
  const bookings = useQuery({
    queryKey: ['bookings', status],
    queryFn: () =>
      api<{ items: BookingRow[]; more: boolean; counts: Partial<Record<Status, number>> }>(
        `/admin/bookings${status === 'all' ? '' : `?status=${status}`}`,
      ),
  });
  const counts = bookings.data?.counts ?? {};
  const label = (s: Status) => (counts[s] ? `${STATUS_LABEL[s]} (${counts[s]})` : STATUS_LABEL[s]);
  return (
    <>
      <div className="sr-filters">
        <Segmented
          value={status}
          onChange={(v) => setStatus(v as Status | 'all')}
          options={[
            { value: 'requested', label: label('requested') },
            { value: 'quoted', label: label('quoted') },
            { value: 'confirmed', label: label('confirmed') },
            { value: 'assigned', label: label('assigned') },
            { value: 'in_progress', label: label('in_progress') },
            { value: 'completed', label: STATUS_LABEL.completed },
            { value: 'cancelled', label: STATUS_LABEL.cancelled },
            { value: 'all', label: 'All' },
          ]}
        />
      </div>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="Bookings from “Book a Rakshak” in the app. Phone numbers are partly hidden and only the place name is shown. Every view and action is written to the audit log. The Rakshak app is not built yet, so a booking moves forward only when an admin does it here."
      />
      <SectionCard>
        {bookings.isPending ? (
          <LoadingState />
        ) : bookings.isError ? (
          <ErrorState onRetry={() => void bookings.refetch()} />
        ) : (
          <Table
            className="sr-table"
            rowKey="id"
            dataSource={bookings.data.items}
            pagination={false}
            scroll={{ x: 'max-content' }}
            onRow={(r) => ({ onClick: () => setOpen(r.id), style: { cursor: 'pointer' } })}
            columns={[
              {
                title: 'Requested',
                key: 'c',
                render: (_: unknown, r: BookingRow) => formatTimeShort(r.createdAt),
              },
              { title: 'Service', dataIndex: 'serviceName', key: 's' },
              {
                title: 'User',
                key: 'u',
                render: (_: unknown, r: BookingRow) => (
                  <>
                    {r.userName ?? 'No name'}
                    <div className="sr-muted">{r.userPhone}</div>
                  </>
                ),
              },
              {
                title: 'When',
                key: 'w',
                render: (_: unknown, r: BookingRow) =>
                  `${formatTimeShort(r.windowStart)} – ${formatTimeShort(r.windowEnd)}`,
              },
              {
                title: 'Place',
                key: 'p',
                render: (_: unknown, r: BookingRow) => r.placeLabel ?? '—',
              },
              {
                title: 'Quote',
                key: 'q',
                render: (_: unknown, r: BookingRow) =>
                  r.quoteAmountPaise === null ? '—' : rupees(r.quoteAmountPaise),
              },
              {
                title: 'Rakshak',
                key: 'r',
                render: (_: unknown, r: BookingRow) => r.rakshakName ?? '—',
              },
              {
                title: 'Status',
                key: 'st',
                render: (_: unknown, r: BookingRow) => (
                  <Tag color={STATUS_COLOUR[r.status]}>{STATUS_LABEL[r.status]}</Tag>
                ),
              },
              { title: '', key: 'o', render: () => <Button size="small">Open</Button> },
            ]}
            locale={{
              emptyText: (
                <EmptyState
                  icon="inbox"
                  title="No bookings"
                  text="When a user books a Rakshak in the app, the booking appears here. Bookings are off for everyone until you switch “Book a Rakshak” on in Settings."
                />
              ),
            }}
          />
        )}
        {bookings.data?.more && (
          <p className="sr-muted" style={{ padding: 12 }}>
            Showing the newest 50. Choose a status to narrow the list.
          </p>
        )}
      </SectionCard>
      {open && <BookingDrawer id={open} onClose={() => setOpen(null)} />}
    </>
  );
}

function BookingDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient();
  const me = useMe();
  const isSuper = me.data?.role === 'super_admin';
  const [dialog, setDialog] = useState<'quote' | 'assign' | 'cancel' | null>(null);
  const booking = useQuery({
    queryKey: ['booking', id],
    queryFn: () => api<BookingDetail>(`/admin/bookings/${id}`),
  });
  const act = useMutation({
    mutationFn: (v: { path: string; body: object }) =>
      api<BookingDetail>(`/admin/bookings/${id}/${v.path}`, { method: 'POST', body: v.body }),
    onSuccess: (data) => {
      qc.setQueryData(['booking', id], data);
      void qc.invalidateQueries({ queryKey: ['bookings'] });
    },
  });
  const b = booking.data;
  const live = b && b.status !== 'completed' && b.status !== 'cancelled';
  return (
    <Drawer
      open
      width={560}
      title="Booking"
      onClose={onClose}
      extra={
        live && (
          <Space wrap>
            <Button danger onClick={() => setDialog('cancel')}>
              Cancel booking
            </Button>
            {isSuper && (b.status === 'requested' || b.status === 'quoted') && (
              <Button onClick={() => setDialog('quote')}>
                {b.status === 'quoted' ? 'Change quote' : 'Send quote'}
              </Button>
            )}
            {(b.status === 'requested' || b.status === 'confirmed' || b.status === 'assigned') && (
              <Button type="primary" onClick={() => setDialog('assign')}>
                {b.status === 'assigned' ? 'Change Rakshak' : 'Assign Rakshak'}
              </Button>
            )}
            {b.status === 'assigned' && (
              <Button
                loading={act.isPending}
                onClick={() => act.mutate({ path: 'status', body: { status: 'in_progress' } })}
              >
                Mark started
              </Button>
            )}
            {(b.status === 'assigned' || b.status === 'in_progress') && (
              <Button
                type="primary"
                loading={act.isPending}
                onClick={() => act.mutate({ path: 'status', body: { status: 'completed' } })}
              >
                Mark completed
              </Button>
            )}
          </Space>
        )
      }
    >
      {booking.isPending ? (
        <LoadingState />
      ) : booking.isError || !b ? (
        <ErrorState onRetry={() => void booking.refetch()} />
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
            <Descriptions.Item label="Service">{b.serviceName}</Descriptions.Item>
            <Descriptions.Item label="Status">
              <Tag color={STATUS_COLOUR[b.status]}>{STATUS_LABEL[b.status]}</Tag>
              {b.status === 'cancelled' && b.cancelReason ? ` ${b.cancelReason}` : ''}
            </Descriptions.Item>
            <Descriptions.Item label="User">
              {b.user.name ?? 'No name'} · {b.user.phone}
            </Descriptions.Item>
            <Descriptions.Item label="When">
              {formatTimeShort(b.windowStart)} – {formatTimeShort(b.windowEnd)}
            </Descriptions.Item>
            <Descriptions.Item label="Place">{b.placeLabel ?? '—'}</Descriptions.Item>
            <Descriptions.Item label="Notes">{b.notes ?? '—'}</Descriptions.Item>
            <Descriptions.Item label="Quote">
              {b.quote
                ? `${rupees(b.quote.amountPaise)}${b.quote.note ? ` · ${b.quote.note}` : ''}${
                    b.quote.expiresAt ? ` · valid until ${formatTimeShort(b.quote.expiresAt)}` : ''
                  }`
                : 'No quote yet'}
            </Descriptions.Item>
            <Descriptions.Item label="Rakshak">{b.rakshak?.firstName ?? '—'}</Descriptions.Item>
            <Descriptions.Item label="Requested">{formatTimeShort(b.createdAt)}</Descriptions.Item>
          </Descriptions>
          <h4 style={{ marginTop: 20 }}>History (cannot be edited)</h4>
          <ul style={{ paddingLeft: 18 }}>
            {b.history.map((h, i) => (
              <li key={i}>
                {STATUS_LABEL[h.status as Status] ?? h.status} · {ACTOR[h.by] ?? h.by} ·{' '}
                <span className="sr-muted">{formatTimeShort(h.at)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      {dialog === 'quote' && (
        <QuoteModal
          onClose={() => setDialog(null)}
          onSave={(body) => act.mutateAsync({ path: 'quote', body }).then(() => setDialog(null))}
        />
      )}
      {dialog === 'assign' && (
        <AssignModal
          onClose={() => setDialog(null)}
          onSave={(rakshakUserId) =>
            act.mutateAsync({ path: 'assign', body: { rakshakUserId } }).then(() => setDialog(null))
          }
        />
      )}
      {dialog === 'cancel' && (
        <CancelModal
          onClose={() => setDialog(null)}
          onSave={(reason) =>
            act.mutateAsync({ path: 'cancel', body: { reason } }).then(() => setDialog(null))
          }
        />
      )}
    </Drawer>
  );
}

function QuoteModal(props: { onClose: () => void; onSave: (body: object) => Promise<unknown> }) {
  const [amount, setAmount] = useState<number | null>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal
      open
      title="Send a quote"
      okText="Send quote"
      okButtonProps={{ disabled: amount === null }}
      onCancel={props.onClose}
      onOk={() =>
        void props
          .onSave({
            amountPaise: Math.round((amount ?? 0) * 100),
            ...(note.trim() && { note: note.trim() }),
          })
          .catch((e: unknown) => setError(errorText(e)))
      }
    >
      <p>
        The user gets a notification and can accept or decline in the app. No payment is taken yet.
      </p>
      <InputNumber
        min={0}
        max={100000}
        prefix="₹"
        style={{ width: '100%', marginBottom: 12 }}
        value={amount}
        onChange={setAmount}
        placeholder="Amount in rupees"
      />
      <Input
        maxLength={200}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Note for the user (optional), for example “Two hours”"
      />
      {error && <Alert type="error" showIcon title={error} style={{ marginTop: 12 }} />}
    </Modal>
  );
}

function AssignModal(props: { onClose: () => void; onSave: (id: string) => Promise<unknown> }) {
  const [rakshak, setRakshak] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const list = useQuery({
    queryKey: ['booking-rakshaks'],
    queryFn: () =>
      api<{ items: { userId: string; firstName: string; area: string; online: boolean }[] }>(
        '/admin/bookings/rakshaks',
      ),
  });
  return (
    <Modal
      open
      title="Assign a Rakshak"
      okText="Assign"
      okButtonProps={{ disabled: !rakshak }}
      onCancel={props.onClose}
      onOk={() => void props.onSave(rakshak!).catch((e: unknown) => setError(errorText(e)))}
    >
      {list.isPending ? (
        <LoadingState />
      ) : list.isError ? (
        <ErrorState onRetry={() => void list.refetch()} />
      ) : list.data.items.length === 0 ? (
        <EmptyState
          icon="inbox"
          title="No approved Rakshaks"
          text="Approve an application in Rakshak Applications first (Super Admin)."
        />
      ) : (
        <Select
          style={{ width: '100%' }}
          placeholder="Choose an approved Rakshak"
          value={rakshak}
          onChange={setRakshak}
          options={list.data.items.map((r) => ({
            value: r.userId,
            label: `${r.firstName} · ${r.area}${r.online ? ' · online' : ''}`,
          }))}
        />
      )}
      {error && <Alert type="error" showIcon title={error} style={{ marginTop: 12 }} />}
    </Modal>
  );
}

function CancelModal(props: { onClose: () => void; onSave: (r: string) => Promise<unknown> }) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal
      open
      title="Cancel this booking"
      okText="Cancel booking"
      okButtonProps={{ danger: true, disabled: reason.trim().length < 5 }}
      onCancel={props.onClose}
      onOk={() => void props.onSave(reason.trim()).catch((e: unknown) => setError(errorText(e)))}
    >
      <p>The reason is sent to the user.</p>
      <Input.TextArea
        rows={3}
        maxLength={500}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Reason (at least 5 characters)"
      />
      {error && <Alert type="error" showIcon title={error} style={{ marginTop: 12 }} />}
    </Modal>
  );
}
