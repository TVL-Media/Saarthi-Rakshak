import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Button,
  Descriptions,
  Drawer,
  Form,
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

// Phase 4 admin screen: Safety Services. Partners (safe points, women support, lawyers) move through
// submitted → verified → approved (Super Admin, with an expiry date) → expired. Support and legal
// requests are moved on by hand. Guidance is reviewed text with a review date. Incident reports and
// child data are private: only counts are shown, never their content.

type Tab = 'overview' | 'partners' | 'requests' | 'guidance';
type PartnerKind = 'safe_point' | 'women_support' | 'lawyer';
type PartnerStatus = 'submitted' | 'verified' | 'approved' | 'rejected' | 'expired';
type RequestStatus = 'requested' | 'accepted' | 'declined' | 'contacted' | 'in_progress' | 'closed';

const KIND_LABEL: Record<PartnerKind, string> = {
  safe_point: 'Safe point',
  women_support: 'Women support',
  lawyer: 'Lawyer',
};
const STATUS_COLOUR: Record<PartnerStatus, string> = {
  submitted: 'gold',
  verified: 'blue',
  approved: 'green',
  rejected: 'red',
  expired: 'default',
};
const REQUEST_LABEL: Record<RequestStatus, string> = {
  requested: 'Requested',
  accepted: 'Accepted',
  declined: 'Declined',
  contacted: 'Contacted',
  in_progress: 'In progress',
  closed: 'Closed',
};
const SITUATIONS = ['threat', 'harassment', 'stalking', 'medical', 'travel', 'child', 'senior'];
const SAFE_CATEGORIES = ['police', 'hospital', 'pharmacy', 'petrol', 'help_desk', 'partner'];
const SUPPORT_CATEGORIES = ['counselling', 'shelter', 'helpline', 'medical', 'legal_aid'];
const LAWYER_CATEGORIES = ['criminal', 'family', 'employment', 'cyber', 'civil', 'other'];

const errorText = (e: unknown) =>
  e instanceof ApiError
    ? (e.serverMessage ?? 'Something went wrong. Please try again.')
    : 'Something went wrong. Please try again.';

export function SafetyServicesBody() {
  const [tab, setTab] = useState<Tab>('overview');
  return (
    <>
      <div className="sr-filters">
        <Segmented
          value={tab}
          onChange={(v) => setTab(v as Tab)}
          options={[
            { value: 'overview', label: 'Overview' },
            { value: 'partners', label: 'Partners' },
            { value: 'requests', label: 'Requests' },
            { value: 'guidance', label: 'Guidance' },
          ]}
        />
      </div>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="A badge means a partner completed onboarding and verification and is still valid. It never means guaranteed protection. Incident reports and child data are private: only counts are shown here. Every view and action is written to the audit log."
      />
      {tab === 'overview' && <Overview />}
      {tab === 'partners' && <Partners />}
      {tab === 'requests' && <Requests />}
      {tab === 'guidance' && <Guidance />}
    </>
  );
}

// ---- Overview ------------------------------------------------------------------------------------

interface OverviewData {
  reports: { kind: string; status: string; count: number }[];
  requests: { status: string; count: number }[];
  childLinks: { status: string; count: number }[];
  partners: { kind: PartnerKind; status: PartnerStatus; count: number }[];
}

function Overview() {
  const q = useQuery({
    queryKey: ['phase4-overview'],
    queryFn: () => api<OverviewData>('/admin/phase4/overview'),
  });
  if (q.isPending) return <LoadingState />;
  if (q.isError) return <ErrorState onRetry={() => void q.refetch()} />;
  const d = q.data;
  const none = (n: number) =>
    n === 0 ? (
      <EmptyState
        icon="inbox"
        title="Nothing yet"
        text="Numbers appear here as people use the app."
      />
    ) : null;
  return (
    <div className="sr-cols">
      <SectionCard title="Partners">
        {none(d.partners.length)}
        {d.partners.length > 0 && (
          <Table
            className="sr-table"
            rowKey={(r) => `${r.kind}-${r.status}`}
            pagination={false}
            dataSource={d.partners}
            columns={[
              { title: 'Type', key: 'k', render: (_: unknown, r) => KIND_LABEL[r.kind] },
              {
                title: 'Status',
                key: 's',
                render: (_: unknown, r) => <Tag color={STATUS_COLOUR[r.status]}>{r.status}</Tag>,
              },
              { title: 'Count', dataIndex: 'count', key: 'c' },
            ]}
          />
        )}
      </SectionCard>
      <SectionCard title="Support and legal requests">
        {none(d.requests.length)}
        {d.requests.length > 0 && (
          <Table
            className="sr-table"
            rowKey="status"
            pagination={false}
            dataSource={d.requests}
            columns={[
              {
                title: 'Status',
                key: 's',
                render: (_: unknown, r) => REQUEST_LABEL[r.status as RequestStatus] ?? r.status,
              },
              { title: 'Count', dataIndex: 'count', key: 'c' },
            ]}
          />
        )}
      </SectionCard>
      <SectionCard title="Incident reports (counts only)">
        {none(d.reports.length)}
        {d.reports.length > 0 && (
          <Table
            className="sr-table"
            rowKey={(r) => `${r.kind}-${r.status}`}
            pagination={false}
            dataSource={d.reports}
            columns={[
              { title: 'Kind', dataIndex: 'kind', key: 'k' },
              { title: 'Status', dataIndex: 'status', key: 's' },
              { title: 'Count', dataIndex: 'count', key: 'c' },
            ]}
          />
        )}
      </SectionCard>
      <SectionCard title="Child links (counts only)">
        {none(d.childLinks.length)}
        {d.childLinks.length > 0 && (
          <Table
            className="sr-table"
            rowKey="status"
            pagination={false}
            dataSource={d.childLinks}
            columns={[
              { title: 'Status', dataIndex: 'status', key: 's' },
              { title: 'Count', dataIndex: 'count', key: 'c' },
            ]}
          />
        )}
      </SectionCard>
    </div>
  );
}

// ---- Partners ------------------------------------------------------------------------------------

interface PartnerRow {
  id: string;
  kind: PartnerKind;
  name: string;
  category: string;
  city: string | null;
  phone: string | null;
  status: PartnerStatus;
  hasLocation: boolean;
  expiresAt: string | null;
}

interface PartnerDetail {
  id: string;
  kind: PartnerKind;
  name: string;
  category: string;
  address: string | null;
  city: string | null;
  phone: string | null;
  hours: string | null;
  languages: string[];
  services: string | null;
  status: PartnerStatus;
  expiresAt: string | null;
  lat: number | null;
  lng: number | null;
}

function Partners() {
  const [kind, setKind] = useState<PartnerKind | 'all'>('all');
  const [status, setStatus] = useState<PartnerStatus | 'all'>('all');
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const params = new URLSearchParams();
  if (kind !== 'all') params.set('kind', kind);
  if (status !== 'all') params.set('status', status);
  const q = useQuery({
    queryKey: ['phase4-partners', kind, status],
    queryFn: () => api<{ items: PartnerRow[] }>(`/admin/phase4/partners?${params.toString()}`),
  });
  return (
    <>
      <div className="sr-filters">
        <Select
          value={kind}
          onChange={setKind}
          style={{ minWidth: 170 }}
          options={[
            { value: 'all', label: 'All types' },
            ...(Object.keys(KIND_LABEL) as PartnerKind[]).map((k) => ({
              value: k,
              label: KIND_LABEL[k],
            })),
          ]}
        />
        <Select
          value={status}
          onChange={setStatus}
          style={{ minWidth: 150 }}
          options={[
            { value: 'all', label: 'Any status' },
            ...(['submitted', 'verified', 'approved', 'rejected', 'expired'] as const).map((s) => ({
              value: s,
              label: s[0].toUpperCase() + s.slice(1),
            })),
          ]}
        />
        <Button type="primary" onClick={() => setAdding(true)}>
          Add partner
        </Button>
      </div>
      <SectionCard>
        {q.isPending ? (
          <LoadingState />
        ) : q.isError ? (
          <ErrorState onRetry={() => void q.refetch()} />
        ) : (
          <Table
            className="sr-table"
            rowKey="id"
            dataSource={q.data.items}
            pagination={false}
            scroll={{ x: 'max-content' }}
            onRow={(r) => ({ onClick: () => setOpen(r.id), style: { cursor: 'pointer' } })}
            columns={[
              { title: 'Name', dataIndex: 'name', key: 'n' },
              {
                title: 'Type',
                key: 'k',
                render: (_: unknown, r: PartnerRow) => KIND_LABEL[r.kind],
              },
              { title: 'Category', dataIndex: 'category', key: 'c' },
              { title: 'City', key: 'ci', render: (_: unknown, r: PartnerRow) => r.city ?? '—' },
              {
                title: 'Status',
                key: 's',
                render: (_: unknown, r: PartnerRow) => (
                  <Tag color={STATUS_COLOUR[r.status]}>{r.status}</Tag>
                ),
              },
              {
                title: 'Badge until',
                key: 'e',
                render: (_: unknown, r: PartnerRow) =>
                  r.status === 'approved' && r.expiresAt ? formatTimeShort(r.expiresAt) : '—',
              },
              { title: '', key: 'o', render: () => <Button size="small">Open</Button> },
            ]}
            locale={{
              emptyText: (
                <EmptyState
                  icon="inbox"
                  title="No partners"
                  text="Add safe points, women support partners and lawyers here. They appear in the app only after they are verified and approved."
                />
              ),
            }}
          />
        )}
      </SectionCard>
      {adding && (
        <PartnerForm
          onClose={() => setAdding(false)}
          onSaved={(id) => {
            setAdding(false);
            setOpen(id);
          }}
        />
      )}
      {open && <PartnerDrawer id={open} onClose={() => setOpen(null)} />}
    </>
  );
}

function PartnerForm({
  initial,
  onClose,
  onSaved,
}: {
  initial?: PartnerDetail;
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const qc = useQueryClient();
  const [form] = Form.useForm();
  const kind = Form.useWatch('kind', form) as PartnerKind | undefined;
  const save = useMutation({
    mutationFn: (v: Record<string, unknown>) =>
      api<PartnerDetail>(
        initial ? `/admin/phase4/partners/${initial.id}` : '/admin/phase4/partners',
        {
          method: 'POST',
          body: v,
        },
      ),
    onSuccess: (d) => {
      void qc.invalidateQueries({ queryKey: ['phase4-partners'] });
      void qc.invalidateQueries({ queryKey: ['phase4-partner', d.id] });
      onSaved(d.id);
    },
  });
  const categories =
    kind === 'safe_point'
      ? SAFE_CATEGORIES
      : kind === 'lawyer'
        ? LAWYER_CATEGORIES
        : SUPPORT_CATEGORIES;
  return (
    <Modal
      open
      title={initial ? 'Edit partner' : 'Add partner'}
      onCancel={onClose}
      okText="Save"
      confirmLoading={save.isPending}
      onOk={() => form.submit()}
      destroyOnHidden
    >
      {initial && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="Saving changes sends the partner back to “submitted”. The badge comes off until it is verified and approved again."
        />
      )}
      {save.isError && (
        <Alert type="error" showIcon title={errorText(save.error)} style={{ marginBottom: 12 }} />
      )}
      <Form
        form={form}
        layout="vertical"
        initialValues={
          initial
            ? { ...initial, languages: initial.languages }
            : { kind: 'safe_point', languages: [] }
        }
        onFinish={(v: Record<string, unknown>) => {
          const clean: Record<string, unknown> = { ...v };
          for (const k of ['address', 'city', 'phone', 'hours', 'services', 'lat', 'lng']) {
            if (clean[k] === '' || clean[k] === undefined) clean[k] = null;
          }
          save.mutate(clean);
        }}
      >
        <Form.Item name="kind" label="Type" rules={[{ required: true }]}>
          <Select
            disabled={!!initial}
            options={(Object.keys(KIND_LABEL) as PartnerKind[]).map((k) => ({
              value: k,
              label: KIND_LABEL[k],
            }))}
            onChange={() => form.setFieldValue('category', undefined)}
          />
        </Form.Item>
        <Form.Item name="name" label="Name" rules={[{ required: true, min: 2 }]}>
          <Input maxLength={120} />
        </Form.Item>
        <Form.Item name="category" label="Category" rules={[{ required: true }]}>
          <Select options={categories.map((c) => ({ value: c, label: c.replace('_', ' ') }))} />
        </Form.Item>
        <Form.Item name="address" label="Address">
          <Input maxLength={240} />
        </Form.Item>
        <Form.Item name="city" label="City">
          <Input maxLength={80} />
        </Form.Item>
        <Form.Item name="phone" label="Phone (shown to users, so it must be checked)">
          <Input maxLength={20} />
        </Form.Item>
        <Form.Item name="hours" label="Hours">
          <Input maxLength={160} placeholder="e.g. Mon–Sat 9:00–18:00" />
        </Form.Item>
        <Form.Item name="languages" label="Languages (codes)">
          <Select mode="tags" tokenSeparators={[',']} placeholder="en, hi" />
        </Form.Item>
        <Form.Item name="services" label="Services">
          <Input.TextArea rows={2} maxLength={400} />
        </Form.Item>
        <Space>
          <Form.Item name="lat" label={kind === 'safe_point' ? 'Latitude (required)' : 'Latitude'}>
            <InputNumber min={-90} max={90} step={0.0001} style={{ width: 150 }} />
          </Form.Item>
          <Form.Item
            name="lng"
            label={kind === 'safe_point' ? 'Longitude (required)' : 'Longitude'}
          >
            <InputNumber min={-180} max={180} step={0.0001} style={{ width: 150 }} />
          </Form.Item>
        </Space>
      </Form>
    </Modal>
  );
}

function PartnerDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient();
  const me = useMe();
  const isSuper = me.data?.role === 'super_admin';
  const [editing, setEditing] = useState(false);
  const [dialog, setDialog] = useState<'approve' | 'reject' | 'expire' | null>(null);
  const q = useQuery({
    queryKey: ['phase4-partner', id],
    queryFn: () => api<PartnerDetail>(`/admin/phase4/partners/${id}`),
  });
  const act = useMutation({
    mutationFn: (body: object) =>
      api<PartnerDetail>(`/admin/phase4/partners/${id}/action`, { method: 'POST', body }),
    onSuccess: (d) => {
      qc.setQueryData(['phase4-partner', id], d);
      void qc.invalidateQueries({ queryKey: ['phase4-partners'] });
      setDialog(null);
    },
  });
  const p = q.data;
  return (
    <Drawer
      open
      width={520}
      title="Partner"
      onClose={onClose}
      extra={
        p && (
          <Space wrap>
            <Button onClick={() => setEditing(true)}>Edit</Button>
            {p.status === 'submitted' && (
              <Button
                type="primary"
                loading={act.isPending}
                onClick={() => act.mutate({ action: 'verify' })}
              >
                Mark verified
              </Button>
            )}
            {isSuper && p.status === 'verified' && (
              <Button type="primary" onClick={() => setDialog('approve')}>
                Approve
              </Button>
            )}
            {isSuper && (p.status === 'submitted' || p.status === 'verified') && (
              <Button danger onClick={() => setDialog('reject')}>
                Reject
              </Button>
            )}
            {isSuper && p.status === 'approved' && (
              <Button danger onClick={() => setDialog('expire')}>
                Remove badge now
              </Button>
            )}
          </Space>
        )
      }
    >
      {q.isPending ? (
        <LoadingState />
      ) : q.isError || !p ? (
        <ErrorState onRetry={() => void q.refetch()} />
      ) : (
        <>
          {act.isError && !dialog && (
            <Alert
              type="error"
              showIcon
              message={errorText(act.error)}
              style={{ marginBottom: 12 }}
            />
          )}
          <Descriptions column={1} bordered size="small">
            <Descriptions.Item label="Name">{p.name}</Descriptions.Item>
            <Descriptions.Item label="Type">{KIND_LABEL[p.kind]}</Descriptions.Item>
            <Descriptions.Item label="Category">{p.category}</Descriptions.Item>
            <Descriptions.Item label="Status">
              <Tag color={STATUS_COLOUR[p.status]}>{p.status}</Tag>
              {p.status === 'approved' && p.expiresAt
                ? ` badge until ${formatTimeShort(p.expiresAt)}`
                : ''}
            </Descriptions.Item>
            <Descriptions.Item label="Address">{p.address ?? '—'}</Descriptions.Item>
            <Descriptions.Item label="City">{p.city ?? '—'}</Descriptions.Item>
            <Descriptions.Item label="Phone">{p.phone ?? '—'}</Descriptions.Item>
            <Descriptions.Item label="Hours">{p.hours ?? '—'}</Descriptions.Item>
            <Descriptions.Item label="Languages">{p.languages.join(', ') || '—'}</Descriptions.Item>
            <Descriptions.Item label="Services">{p.services ?? '—'}</Descriptions.Item>
            <Descriptions.Item label="Map point">
              {p.lat !== null && p.lng !== null ? `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}` : '—'}
            </Descriptions.Item>
          </Descriptions>
          <p className="sr-muted" style={{ marginTop: 12 }}>
            Only approved listings with a valid badge date are shown in the app. A Super Admin
            approves, rejects or removes a badge.
          </p>
        </>
      )}
      {editing && p && (
        <PartnerForm
          initial={p}
          onClose={() => setEditing(false)}
          onSaved={() => setEditing(false)}
        />
      )}
      {dialog && (
        <ActionModal
          kind={dialog}
          busy={act.isPending}
          error={act.isError ? errorText(act.error) : null}
          onClose={() => setDialog(null)}
          onSubmit={(body) => act.mutate(body)}
        />
      )}
    </Drawer>
  );
}

function ActionModal({
  kind,
  busy,
  error,
  onClose,
  onSubmit,
}: {
  kind: 'approve' | 'reject' | 'expire';
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (body: object) => void;
}) {
  const [reason, setReason] = useState('');
  const inAYear = new Date(Date.now() + 365 * 86_400_000).toISOString().slice(0, 10);
  const [date, setDate] = useState(inAYear);
  return (
    <Modal
      open
      title={
        kind === 'approve'
          ? 'Approve partner'
          : kind === 'reject'
            ? 'Reject partner'
            : 'Remove badge now'
      }
      okText={kind === 'approve' ? 'Approve' : 'Confirm'}
      okButtonProps={{ danger: kind !== 'approve' }}
      confirmLoading={busy}
      onCancel={onClose}
      onOk={() =>
        onSubmit(
          kind === 'approve'
            ? { action: 'approve', expiresAt: new Date(`${date}T23:59:59+05:30`).toISOString() }
            : { action: kind, reason },
        )
      }
    >
      {error && <Alert type="error" showIcon title={error} style={{ marginBottom: 12 }} />}
      {kind === 'approve' ? (
        <>
          <p>The badge stays until this date and then comes off by itself.</p>
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </>
      ) : (
        <Input.TextArea
          rows={3}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Reason (at least 5 characters)"
        />
      )}
    </Modal>
  );
}

// ---- Requests ------------------------------------------------------------------------------------

interface RequestRow {
  id: string;
  kind: 'women_support' | 'legal';
  category: string;
  urgency: string;
  status: RequestStatus;
  reference: string;
  userPhone: string;
  partnerName: string | null;
  createdAt: string;
}

interface RequestDetail extends RequestRow {
  preferredContact: string;
  summary: string;
  internalNote: string | null;
  sharedItemCount: number;
  sharedUntil: string | null;
  partnerId: string | null;
  timeline: { status: string; by: string; note: string | null; at: string }[];
}

function Requests() {
  const [status, setStatus] = useState<RequestStatus | 'all'>('requested');
  const [open, setOpen] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ['phase4-requests', status],
    queryFn: () =>
      api<{ items: RequestRow[] }>(
        `/admin/phase4/requests${status === 'all' ? '' : `?status=${status}`}`,
      ),
  });
  return (
    <>
      <div className="sr-filters">
        <Segmented
          value={status}
          onChange={(v) => setStatus(v as RequestStatus | 'all')}
          options={[
            ...(Object.keys(REQUEST_LABEL) as RequestStatus[]).map((s) => ({
              value: s,
              label: REQUEST_LABEL[s],
            })),
            { value: 'all', label: 'All' },
          ]}
        />
      </div>
      <SectionCard>
        {q.isPending ? (
          <LoadingState />
        ) : q.isError ? (
          <ErrorState onRetry={() => void q.refetch()} />
        ) : (
          <Table
            className="sr-table"
            rowKey="id"
            dataSource={q.data.items}
            pagination={false}
            scroll={{ x: 'max-content' }}
            onRow={(r) => ({ onClick: () => setOpen(r.id), style: { cursor: 'pointer' } })}
            columns={[
              {
                title: 'Received',
                key: 'c',
                render: (_: unknown, r: RequestRow) => formatTimeShort(r.createdAt),
              },
              { title: 'Reference', dataIndex: 'reference', key: 'r' },
              {
                title: 'Kind',
                key: 'k',
                render: (_: unknown, r: RequestRow) =>
                  r.kind === 'legal' ? 'Legal' : 'Women support',
              },
              { title: 'Category', dataIndex: 'category', key: 'ca' },
              { title: 'Urgency', dataIndex: 'urgency', key: 'u' },
              { title: 'User', dataIndex: 'userPhone', key: 'p' },
              {
                title: 'Partner',
                key: 'pa',
                render: (_: unknown, r: RequestRow) => r.partnerName ?? 'Not chosen',
              },
              {
                title: 'Status',
                key: 's',
                render: (_: unknown, r: RequestRow) => <Tag>{REQUEST_LABEL[r.status]}</Tag>,
              },
              { title: '', key: 'o', render: () => <Button size="small">Open</Button> },
            ]}
            locale={{
              emptyText: (
                <EmptyState
                  icon="inbox"
                  title="No requests"
                  text="When a user asks a support partner or a lawyer for help in the app, the request appears here. The features are off until you switch them on in Settings."
                />
              ),
            }}
          />
        )}
      </SectionCard>
      {open && <RequestDrawer id={open} onClose={() => setOpen(null)} />}
    </>
  );
}

function RequestDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['phase4-request', id],
    queryFn: () => api<RequestDetail>(`/admin/phase4/requests/${id}`),
  });
  const partners = useQuery({
    queryKey: ['phase4-partners', 'approved-for', q.data?.kind],
    enabled: !!q.data,
    queryFn: () =>
      api<{ items: PartnerRow[] }>(
        `/admin/phase4/partners?status=approved&kind=${q.data?.kind === 'legal' ? 'lawyer' : 'women_support'}`,
      ),
  });
  const [status, setStatus] = useState<Exclude<RequestStatus, 'requested'>>('accepted');
  const [message, setMessage] = useState('');
  const [note, setNote] = useState('');
  const [partnerId, setPartnerId] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () =>
      api<RequestDetail>(`/admin/phase4/requests/${id}/status`, {
        method: 'POST',
        body: {
          status,
          ...(message.trim() && { message: message.trim() }),
          ...(note.trim() && { internalNote: note.trim() }),
          ...(partnerId && { partnerId }),
        },
      }),
    onSuccess: (d) => {
      qc.setQueryData(['phase4-request', id], d);
      void qc.invalidateQueries({ queryKey: ['phase4-requests'] });
      setMessage('');
    },
  });
  const r = q.data;
  return (
    <Drawer open width={560} title="Request" onClose={onClose}>
      {q.isPending ? (
        <LoadingState />
      ) : q.isError || !r ? (
        <ErrorState onRetry={() => void q.refetch()} />
      ) : (
        <>
          <Descriptions column={1} bordered size="small">
            <Descriptions.Item label="Reference">{r.reference}</Descriptions.Item>
            <Descriptions.Item label="Kind">
              {r.kind === 'legal' ? 'Legal' : 'Women support'}
            </Descriptions.Item>
            <Descriptions.Item label="Category">{r.category}</Descriptions.Item>
            <Descriptions.Item label="Urgency">{r.urgency}</Descriptions.Item>
            <Descriptions.Item label="User">
              {r.userPhone} · prefers {r.preferredContact}
            </Descriptions.Item>
            <Descriptions.Item label="Summary (written by the user)">{r.summary}</Descriptions.Item>
            <Descriptions.Item label="Shared items">
              {r.sharedItemCount === 0
                ? 'None'
                : `${r.sharedItemCount} selected by the user${r.sharedUntil ? ` · until ${formatTimeShort(r.sharedUntil)}` : ''}. Their content cannot be opened here.`}
            </Descriptions.Item>
            <Descriptions.Item label="Partner">{r.partnerName ?? 'Not chosen'}</Descriptions.Item>
            <Descriptions.Item label="Status">
              <Tag>{REQUEST_LABEL[r.status]}</Tag>
            </Descriptions.Item>
          </Descriptions>
          <h4 style={{ marginTop: 20 }}>Timeline (the user sees this)</h4>
          <ul style={{ paddingLeft: 18 }}>
            {r.timeline.map((t, i) => (
              <li key={i}>
                {REQUEST_LABEL[t.status as RequestStatus] ?? t.status} ·{' '}
                {t.by === 'user' ? 'The user' : t.by === 'admin' ? 'An admin' : 'The system'}
                {t.note ? ` · “${t.note}”` : ''} ·{' '}
                <span className="sr-muted">{formatTimeShort(t.at)}</span>
              </li>
            ))}
          </ul>
          {r.status !== 'closed' && (
            <>
              <h4 style={{ marginTop: 20 }}>Move this request on</h4>
              {save.isError && (
                <Alert
                  type="error"
                  showIcon
                  message={errorText(save.error)}
                  style={{ marginBottom: 12 }}
                />
              )}
              <Space direction="vertical" style={{ width: '100%' }}>
                <Select
                  value={status}
                  onChange={setStatus}
                  style={{ width: '100%' }}
                  options={(
                    ['accepted', 'declined', 'contacted', 'in_progress', 'closed'] as const
                  ).map((s) => ({
                    value: s,
                    label: REQUEST_LABEL[s],
                  }))}
                />
                <Select
                  allowClear
                  placeholder="Route to an approved partner (optional)"
                  value={partnerId}
                  onChange={(v) => setPartnerId(v ?? null)}
                  style={{ width: '100%' }}
                  options={(partners.data?.items ?? []).map((p) => ({
                    value: p.id,
                    label: p.name,
                  }))}
                />
                <Input.TextArea
                  rows={2}
                  maxLength={300}
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  placeholder="Message the user will see (optional). Never promise a response time."
                />
                <Input.TextArea
                  rows={2}
                  maxLength={1000}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder={r.internalNote ?? 'Internal note (the user never sees this)'}
                />
                <Button type="primary" loading={save.isPending} onClick={() => save.mutate()}>
                  Save
                </Button>
              </Space>
            </>
          )}
        </>
      )}
    </Drawer>
  );
}

// ---- Guidance ------------------------------------------------------------------------------------

interface GuidanceRow {
  id: string;
  situation: string;
  title: string;
  steps: string[];
  language: string;
  status: 'draft' | 'approved' | 'retired';
  reviewedOn: string | null;
  reviewDue: string | null;
  reviewExpired: boolean;
}

function Guidance() {
  const qc = useQueryClient();
  const me = useMe();
  const isSuper = me.data?.role === 'super_admin';
  const [editing, setEditing] = useState<GuidanceRow | 'new' | null>(null);
  const [approving, setApproving] = useState<GuidanceRow | null>(null);
  const q = useQuery({
    queryKey: ['phase4-guidance'],
    queryFn: () => api<{ items: GuidanceRow[] }>('/admin/phase4/guidance'),
  });
  const retire = useMutation({
    mutationFn: (id: string) =>
      api<{ items: GuidanceRow[] }>(`/admin/phase4/guidance/${id}/retire`, { method: 'POST' }),
    onSuccess: (d) => qc.setQueryData(['phase4-guidance'], d),
  });
  return (
    <>
      <div className="sr-filters">
        <Button type="primary" onClick={() => setEditing('new')}>
          Add guidance
        </Button>
      </div>
      <SectionCard>
        {q.isPending ? (
          <LoadingState />
        ) : q.isError ? (
          <ErrorState onRetry={() => void q.refetch()} />
        ) : (
          <Table
            className="sr-table"
            rowKey="id"
            dataSource={q.data.items}
            pagination={false}
            scroll={{ x: 'max-content' }}
            columns={[
              { title: 'Situation', dataIndex: 'situation', key: 's' },
              { title: 'Title', dataIndex: 'title', key: 't' },
              { title: 'Steps', key: 'st', render: (_: unknown, r: GuidanceRow) => r.steps.length },
              {
                title: 'Status',
                key: 'sta',
                render: (_: unknown, r: GuidanceRow) =>
                  r.reviewExpired ? (
                    <Tag color="red">Review overdue · hidden</Tag>
                  ) : (
                    <Tag
                      color={
                        r.status === 'approved'
                          ? 'green'
                          : r.status === 'draft'
                            ? 'gold'
                            : 'default'
                      }
                    >
                      {r.status}
                    </Tag>
                  ),
              },
              {
                title: 'Review due',
                key: 'd',
                render: (_: unknown, r: GuidanceRow) => r.reviewDue ?? '—',
              },
              {
                title: '',
                key: 'a',
                render: (_: unknown, r: GuidanceRow) => (
                  <Space>
                    <Button size="small" onClick={() => setEditing(r)}>
                      Edit
                    </Button>
                    {isSuper && r.status !== 'retired' && (
                      <Button size="small" type="primary" onClick={() => setApproving(r)}>
                        {r.status === 'approved' ? 'Renew review' : 'Approve'}
                      </Button>
                    )}
                    {isSuper && r.status === 'approved' && (
                      <Button
                        size="small"
                        danger
                        loading={retire.isPending}
                        onClick={() => retire.mutate(r.id)}
                      >
                        Retire
                      </Button>
                    )}
                  </Space>
                ),
              },
            ]}
            locale={{
              emptyText: (
                <EmptyState
                  icon="inbox"
                  title="No guidance yet"
                  text="Write short steps for each situation. Only text a Super Admin has approved, and whose review date has not passed, is shown in the app."
                />
              ),
            }}
          />
        )}
      </SectionCard>
      {editing && (
        <GuidanceForm
          initial={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(null)}
        />
      )}
      {approving && <ApproveGuidance row={approving} onClose={() => setApproving(null)} />}
    </>
  );
}

function GuidanceForm({ initial, onClose }: { initial?: GuidanceRow; onClose: () => void }) {
  const qc = useQueryClient();
  const [form] = Form.useForm();
  const save = useMutation({
    mutationFn: (v: { situation: string; title: string; stepsText: string }) =>
      api<{ items: GuidanceRow[] }>(
        initial ? `/admin/phase4/guidance/${initial.id}` : '/admin/phase4/guidance',
        {
          method: 'POST',
          body: {
            situation: v.situation,
            title: v.title,
            steps: v.stepsText
              .split('\n')
              .map((s) => s.trim())
              .filter(Boolean),
          },
        },
      ),
    onSuccess: (d) => {
      qc.setQueryData(['phase4-guidance'], d);
      onClose();
    },
  });
  return (
    <Modal
      open
      title={initial ? 'Edit guidance' : 'Add guidance'}
      onCancel={onClose}
      okText="Save"
      confirmLoading={save.isPending}
      onOk={() => form.submit()}
      destroyOnHidden
    >
      {initial?.status === 'approved' && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="Saving makes this a draft again. A Super Admin must approve it before the app shows it."
        />
      )}
      {save.isError && (
        <Alert type="error" showIcon title={errorText(save.error)} style={{ marginBottom: 12 }} />
      )}
      <Form
        form={form}
        layout="vertical"
        initialValues={
          initial
            ? {
                situation: initial.situation,
                title: initial.title,
                stepsText: initial.steps.join('\n'),
              }
            : { situation: 'threat' }
        }
        onFinish={(v: { situation: string; title: string; stepsText: string }) => save.mutate(v)}
      >
        <Form.Item name="situation" label="Situation" rules={[{ required: true }]}>
          <Select options={SITUATIONS.map((s) => ({ value: s, label: s }))} />
        </Form.Item>
        <Form.Item name="title" label="Title" rules={[{ required: true, min: 3 }]}>
          <Input maxLength={120} />
        </Form.Item>
        <Form.Item
          name="stepsText"
          label="Steps (one per line, up to 12)"
          rules={[{ required: true }]}
        >
          <Input.TextArea rows={6} />
        </Form.Item>
      </Form>
    </Modal>
  );
}

function ApproveGuidance({ row, onClose }: { row: GuidanceRow; onClose: () => void }) {
  const qc = useQueryClient();
  const today = new Date().toISOString().slice(0, 10);
  const [reviewedOn, setReviewedOn] = useState(today);
  const [reviewDue, setReviewDue] = useState(
    new Date(Date.now() + 180 * 86_400_000).toISOString().slice(0, 10),
  );
  const save = useMutation({
    mutationFn: () =>
      api<{ items: GuidanceRow[] }>(`/admin/phase4/guidance/${row.id}/approve`, {
        method: 'POST',
        body: { reviewedOn, reviewDue },
      }),
    onSuccess: (d) => {
      qc.setQueryData(['phase4-guidance'], d);
      onClose();
    },
  });
  return (
    <Modal
      open
      title="Approve guidance"
      okText="Approve"
      confirmLoading={save.isPending}
      onCancel={onClose}
      onOk={() => save.mutate()}
    >
      {save.isError && (
        <Alert type="error" showIcon title={errorText(save.error)} style={{ marginBottom: 12 }} />
      )}
      <p>
        The text is shown in the app until the next review date. After that it is hidden until it is
        reviewed again.
      </p>
      <Space direction="vertical" style={{ width: '100%' }}>
        <label>
          Reviewed on
          <Input type="date" value={reviewedOn} onChange={(e) => setReviewedOn(e.target.value)} />
        </label>
        <label>
          Next review due
          <Input type="date" value={reviewDue} onChange={(e) => setReviewDue(e.target.value)} />
        </label>
      </Space>
    </Modal>
  );
}
