import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Button,
  Checkbox,
  Descriptions,
  Drawer,
  Image,
  Input,
  InputNumber,
  Modal,
  Segmented,
  Select,
  Space,
  Switch,
  Table,
  Tag,
} from 'antd';
import { useState } from 'react';
import { api, ApiError } from '../api';
import { EmptyState, ErrorState, LoadingState, SectionCard } from '../components/states';
import { formatTimeShort } from '../format';

// Phase 2 admin screens: Community moderation, Rakshak applications, Plans & Subscriptions, the
// Phase 2 counts on Reports, and the Phase 2 part of a user's profile. Evidence: admins see only
// that it was recorded (type, time, size, fingerprint), never what is in it: it is encrypted on
// the user's phone and only they can open it. Full-day location: on / off only, never where.

const errorText = (e: unknown) =>
  e instanceof ApiError
    ? (e.serverMessage ?? 'Something went wrong. Please try again.')
    : 'Something went wrong. Please try again.';

// ---- Community moderation ----------------------------------------------------------------------

type PostStatus = 'pending' | 'published' | 'rejected' | 'removed';
const CATEGORY: Record<string, string> = {
  lighting: 'Lighting',
  unsafe_spot: 'Unsafe spot',
  harassment_area: 'Harassment area',
  road: 'Road',
  other: 'Other',
};
const CATEGORY_OPTIONS = Object.entries(CATEGORY).map(([value, label]) => ({ value, label }));

interface PostRow {
  id: string;
  category: string;
  area: string;
  body: string;
  photoUrl: string | null;
  status: PostStatus;
  reason: string | null;
  flags: number;
  official: boolean;
  createdAt: string;
}

export function CommunityBody() {
  const qc = useQueryClient();
  const [status, setStatus] = useState<PostStatus>('pending');
  const [editing, setEditing] = useState<PostRow | null>(null);
  const [refusing, setRefusing] = useState<{ post: PostRow; action: 'reject' | 'remove' } | null>(
    null,
  );
  const [writing, setWriting] = useState(false);
  const posts = useQuery({
    queryKey: ['community', status],
    queryFn: () =>
      api<{ items: PostRow[]; pendingCount: number }>(`/admin/community/posts?status=${status}`),
  });
  const moderate = useMutation({
    mutationFn: (v: { id: string; body: object }) =>
      api(`/admin/community/posts/${v.id}`, { method: 'PATCH', body: v.body }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['community'] }),
  });

  const columns = [
    {
      title: 'Received',
      key: 't',
      render: (_: unknown, r: PostRow) => formatTimeShort(r.createdAt),
      width: 130,
    },
    {
      title: 'Area · Category',
      key: 'a',
      width: 170,
      render: (_: unknown, r: PostRow) => (
        <div>
          <b>{r.area}</b>
          <div className="sr-muted">
            {CATEGORY[r.category] ?? r.category}
            {r.official ? ' · Official' : ''}
          </div>
        </div>
      ),
    },
    {
      title: 'Report',
      key: 'b',
      render: (_: unknown, r: PostRow) => (
        <div style={{ maxWidth: 460 }}>
          {r.body}
          {r.flags > 0 && (
            <div>
              <span className="sr-badge warn">Flagged by {r.flags}</span>
            </div>
          )}
          {r.reason && <div className="sr-muted">Reason: {r.reason}</div>}
        </div>
      ),
    },
    {
      title: 'Photo',
      key: 'p',
      width: 90,
      render: (_: unknown, r: PostRow) =>
        r.photoUrl ? (
          <Image
            src={r.photoUrl}
            width={64}
            height={64}
            style={{ objectFit: 'cover', borderRadius: 8 }}
          />
        ) : (
          '—'
        ),
    },
    {
      title: '',
      key: 'act',
      width: 260,
      render: (_: unknown, r: PostRow) => (
        <Space wrap>
          {r.status !== 'published' && (
            <Button
              size="small"
              type="primary"
              loading={moderate.isPending}
              onClick={() => moderate.mutate({ id: r.id, body: { action: 'approve' } })}
            >
              Approve
            </Button>
          )}
          {r.status !== 'published' && (
            <Button size="small" onClick={() => setEditing(r)}>
              Edit then approve
            </Button>
          )}
          {r.status === 'pending' && (
            <Button size="small" danger onClick={() => setRefusing({ post: r, action: 'reject' })}>
              Reject
            </Button>
          )}
          {r.status === 'published' && (
            <Button size="small" danger onClick={() => setRefusing({ post: r, action: 'remove' })}>
              Remove
            </Button>
          )}
        </Space>
      ),
    },
  ];

  return (
    <>
      <div className="sr-filters">
        <Segmented
          value={status}
          onChange={(v) => setStatus(v as PostStatus)}
          options={[
            {
              value: 'pending',
              label: `Waiting for review${posts.data ? ` (${posts.data.pendingCount})` : ''}`,
            },
            { value: 'published', label: 'Published' },
            { value: 'rejected', label: 'Rejected' },
            { value: 'removed', label: 'Removed' },
          ]}
        />
        <Button type="primary" onClick={() => setWriting(true)}>
          New official post
        </Button>
      </div>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="Nothing is shown in the app until it is approved. Reject posts that name a person or show a face or number plate (or approve without the photo)."
      />
      {moderate.isError && (
        <Alert
          type="error"
          showIcon
          message={errorText(moderate.error)}
          style={{ marginBottom: 12 }}
        />
      )}
      <SectionCard>
        {posts.isPending ? (
          <LoadingState />
        ) : posts.isError ? (
          <ErrorState onRetry={() => void posts.refetch()} />
        ) : (
          <Table
            className="sr-table"
            rowKey="id"
            columns={columns}
            dataSource={posts.data.items}
            pagination={false}
            scroll={{ x: 'max-content' }}
            locale={{
              emptyText: (
                <EmptyState
                  icon="inbox"
                  title="Nothing here"
                  text="Reports from users appear here for review."
                />
              ),
            }}
          />
        )}
      </SectionCard>
      {editing && (
        <EditPostModal
          post={editing}
          onClose={() => setEditing(null)}
          onSave={(body) =>
            moderate
              .mutateAsync({ id: editing.id, body: { action: 'approve', ...body } })
              .then(() => setEditing(null))
          }
        />
      )}
      {refusing && (
        <ReasonModal
          title={refusing.action === 'reject' ? 'Reject this report' : 'Remove this post'}
          okText={refusing.action === 'reject' ? 'Reject' : 'Remove'}
          onClose={() => setRefusing(null)}
          onSave={(reason) =>
            moderate
              .mutateAsync({ id: refusing.post.id, body: { action: refusing.action, reason } })
              .then(() => setRefusing(null))
          }
        />
      )}
      {writing && <OfficialPostModal onClose={() => setWriting(false)} />}
    </>
  );
}

function EditPostModal(props: {
  post: PostRow;
  onClose: () => void;
  onSave: (b: object) => Promise<unknown>;
}) {
  const [body, setBody] = useState(props.post.body);
  const [area, setArea] = useState(props.post.area);
  const [category, setCategory] = useState(props.post.category);
  const [removePhoto, setRemovePhoto] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal
      open
      title="Edit then approve"
      okText="Approve"
      onCancel={props.onClose}
      onOk={() =>
        void props
          .onSave({ body, area, category, removePhoto })
          .catch((e: unknown) => setError(errorText(e)))
      }
    >
      <p className="sr-muted">
        Fix the wording only. Never add names, phone numbers or other personal details.
      </p>
      <Space direction="vertical" style={{ width: '100%' }}>
        <Input.TextArea
          rows={5}
          maxLength={500}
          showCount
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
        <Input value={area} onChange={(e) => setArea(e.target.value)} addonBefore="Area" />
        <Select
          value={category}
          onChange={setCategory}
          options={CATEGORY_OPTIONS}
          style={{ width: '100%' }}
        />
        {props.post.photoUrl && (
          <Checkbox checked={removePhoto} onChange={(e) => setRemovePhoto(e.target.checked)}>
            Publish without the photo (face or number plate visible)
          </Checkbox>
        )}
        {error && <Alert type="error" showIcon message={error} />}
      </Space>
    </Modal>
  );
}

function ReasonModal(props: {
  title: string;
  okText: string;
  onClose: () => void;
  onSave: (r: string) => Promise<unknown>;
}) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal
      open
      title={props.title}
      okText={props.okText}
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
      {error && <Alert type="error" showIcon message={error} style={{ marginTop: 12 }} />}
    </Modal>
  );
}

function OfficialPostModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [body, setBody] = useState('');
  const [area, setArea] = useState('All Noida');
  const [category, setCategory] = useState('other');
  const save = useMutation({
    mutationFn: () =>
      api('/admin/community/posts', { method: 'POST', body: { body, area, category } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['community'] });
      onClose();
    },
  });
  return (
    <Modal
      open
      title="New official post"
      okText="Publish"
      onCancel={onClose}
      okButtonProps={{ disabled: body.trim().length < 20, loading: save.isPending }}
      onOk={() => save.mutate()}
    >
      <Space direction="vertical" style={{ width: '100%' }}>
        <Input value={area} onChange={(e) => setArea(e.target.value)} addonBefore="Area" />
        <Select
          value={category}
          onChange={setCategory}
          options={CATEGORY_OPTIONS}
          style={{ width: '100%' }}
        />
        <Input.TextArea
          rows={5}
          maxLength={500}
          showCount
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="What people in this area should know (20–500 characters)"
        />
        {save.isError && <Alert type="error" showIcon message={errorText(save.error)} />}
      </Space>
    </Modal>
  );
}

// ---- Rakshak applications ----------------------------------------------------------------------

const ID_TYPE: Record<string, string> = {
  aadhaar: 'Aadhaar',
  pan: 'PAN',
  driving_licence: 'Driving licence',
  voter_id: 'Voter ID',
  passport: 'Passport',
};

interface AppRow {
  id: string;
  area: string;
  idType: string;
  status: 'under_review' | 'approved' | 'rejected';
  createdAt: string;
  decidedAt: string | null;
  /** "Available now" in the app (yes / no and when last seen; never where). */
  availableNow?: boolean;
  lastAvailableAt?: string | null;
}

interface AppDetail extends AppRow {
  fullName: string;
  dateOfBirth: string;
  address: string;
  motivation: string;
  phone: string | null;
  idLast4: string;
  documents: Record<string, string>;
  reason: string | null;
  consentAt: string;
}

export function RakshakBody() {
  const [status, setStatus] = useState<AppRow['status']>('under_review');
  const [open, setOpen] = useState<string | null>(null);
  const apps = useQuery({
    queryKey: ['rakshak', status],
    queryFn: () => api<{ items: AppRow[] }>(`/admin/rakshak/applications?status=${status}`),
  });
  return (
    <>
      <div className="sr-filters">
        <Segmented
          value={status}
          onChange={(v) => setStatus(v as AppRow['status'])}
          options={[
            { value: 'under_review', label: 'Under review' },
            { value: 'approved', label: 'Approved' },
            { value: 'rejected', label: 'Not approved' },
          ]}
        />
      </div>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="Approval only marks the person as an approved Rakshak for Phase 3. Opening an application is written to the audit log. Only the last 4 characters of the ID number are kept."
      />
      <SectionCard>
        {apps.isPending ? (
          <LoadingState />
        ) : apps.isError ? (
          <ErrorState onRetry={() => void apps.refetch()} />
        ) : (
          <Table
            className="sr-table"
            rowKey="id"
            dataSource={apps.data.items}
            pagination={false}
            onRow={(r) => ({ onClick: () => setOpen(r.id), style: { cursor: 'pointer' } })}
            columns={[
              {
                title: 'Applied',
                key: 'c',
                render: (_: unknown, r: AppRow) => formatTimeShort(r.createdAt),
              },
              { title: 'Areas', dataIndex: 'area', key: 'a' },
              {
                title: 'ID type',
                key: 'i',
                render: (_: unknown, r: AppRow) => ID_TYPE[r.idType] ?? r.idType,
              },
              {
                title: 'Decided',
                key: 'd',
                render: (_: unknown, r: AppRow) =>
                  r.decidedAt ? formatTimeShort(r.decidedAt) : '—',
              },
              {
                // Approved Rakshaks only: "Available now" in the app. Never their location.
                title: 'Available',
                key: 'av',
                render: (_: unknown, r: AppRow) =>
                  r.status !== 'approved' ? (
                    '—'
                  ) : r.availableNow ? (
                    <Tag color="green">Available now</Tag>
                  ) : r.lastAvailableAt ? (
                    <span className="sr-muted">Last {formatTimeShort(r.lastAvailableAt)}</span>
                  ) : (
                    <span className="sr-muted">Not yet</span>
                  ),
              },
              { title: '', key: 'o', render: () => <Button size="small">Open</Button> },
            ]}
            locale={{
              emptyText: (
                <EmptyState
                  icon="inbox"
                  title="No applications"
                  text="Applications from “Become a Rakshak” in the app appear here."
                />
              ),
            }}
          />
        )}
      </SectionCard>
      {open && <ApplicationDrawer id={open} onClose={() => setOpen(null)} />}
    </>
  );
}

function ApplicationDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient();
  const [rejecting, setRejecting] = useState(false);
  const app = useQuery({
    queryKey: ['rakshak-app', id],
    queryFn: () => api<AppDetail>(`/admin/rakshak/applications/${id}`),
  });
  const decide = useMutation({
    mutationFn: (body: object) =>
      api(`/admin/rakshak/applications/${id}/decision`, { method: 'POST', body }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['rakshak'] });
      void qc.invalidateQueries({ queryKey: ['rakshak-app', id] });
    },
  });
  const a = app.data;
  return (
    <Drawer
      open
      width={560}
      title="Rakshak application"
      onClose={onClose}
      extra={
        a?.status === 'under_review' && (
          <Space>
            <Button danger onClick={() => setRejecting(true)}>
              Not approve
            </Button>
            <Button
              type="primary"
              loading={decide.isPending}
              onClick={() => decide.mutate({ decision: 'approve' })}
            >
              Approve
            </Button>
          </Space>
        )
      }
    >
      {app.isPending ? (
        <LoadingState />
      ) : app.isError || !a ? (
        <ErrorState onRetry={() => void app.refetch()} />
      ) : (
        <>
          {decide.isError && (
            <Alert
              type="error"
              showIcon
              message={errorText(decide.error)}
              style={{ marginBottom: 12 }}
            />
          )}
          <Descriptions column={1} bordered size="small">
            <Descriptions.Item label="Name">{a.fullName}</Descriptions.Item>
            <Descriptions.Item label="Date of birth">{a.dateOfBirth}</Descriptions.Item>
            <Descriptions.Item label="Phone">{a.phone ?? '—'}</Descriptions.Item>
            <Descriptions.Item label="Address">{a.address}</Descriptions.Item>
            <Descriptions.Item label="Areas">{a.area}</Descriptions.Item>
            <Descriptions.Item label="ID">
              {ID_TYPE[a.idType]} ending {a.idLast4}
            </Descriptions.Item>
            <Descriptions.Item label="Why they want to help">{a.motivation}</Descriptions.Item>
            <Descriptions.Item label="Agreed to checks">
              {formatTimeShort(a.consentAt)}
            </Descriptions.Item>
            <Descriptions.Item label="Status">
              {a.status === 'under_review'
                ? 'Under review'
                : a.status === 'approved'
                  ? 'Approved'
                  : `Not approved: ${a.reason ?? ''}`}
            </Descriptions.Item>
          </Descriptions>
          <h4 style={{ marginTop: 20 }}>Documents (links work for 5 minutes)</h4>
          <Space wrap>
            {Object.entries(a.documents).map(([name, url]) => (
              <div key={name} style={{ textAlign: 'center' }}>
                <Image
                  src={url}
                  width={150}
                  height={110}
                  style={{ objectFit: 'cover', borderRadius: 8 }}
                />
                <div className="sr-muted">
                  {name === 'idFront' ? 'ID front' : name === 'idBack' ? 'ID back' : 'Selfie'}
                </div>
              </div>
            ))}
          </Space>
        </>
      )}
      {rejecting && (
        <ReasonModal
          title="Not approve this application"
          okText="Not approve"
          onClose={() => setRejecting(false)}
          onSave={(reason) =>
            decide.mutateAsync({ decision: 'reject', reason }).then(() => setRejecting(false))
          }
        />
      )}
    </Drawer>
  );
}

// ---- Plans & subscriptions ---------------------------------------------------------------------

interface PlanRow {
  id: 'basic' | 'silver' | 'gold';
  name: string;
  monthlyPriceInr: number | null;
  yearlyPriceInr: number | null;
  monthlyProductId: string | null;
  yearlyProductId: string | null;
  features: string[];
  evidenceStorageMb: number;
  onSale: boolean;
  activeSubscribers: number;
}

interface SubRow {
  id: string;
  plan: string;
  status: string;
  phone: string | null;
  renewsAt: string | null;
  createdAt: string;
}

export function PlansBody() {
  const [editing, setEditing] = useState<PlanRow | null>(null);
  const plans = useQuery({
    queryKey: ['plans'],
    queryFn: () => api<{ plans: PlanRow[]; everythingFree: boolean }>('/admin/plans'),
  });
  const subs = useQuery({
    queryKey: ['subscriptions'],
    queryFn: () => api<{ items: SubRow[] }>('/admin/subscriptions'),
  });
  if (plans.isPending) return <LoadingState />;
  if (plans.isError) return <ErrorState onRetry={() => void plans.refetch()} />;
  return (
    <>
      {plans.data.everythingFree && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message="No plan is on sale: every feature is free for everyone. SOS, guardians and live location are always free."
        />
      )}
      <div className="sr-chart-grid">
        {plans.data.plans.map((p) => (
          <SectionCard key={p.id} title={p.name}>
            <div className="sr-status-row">
              <span>Monthly</span>
              <b>{p.monthlyPriceInr === null ? 'Not set' : `₹${p.monthlyPriceInr}`}</b>
            </div>
            <div className="sr-status-row">
              <span>Yearly</span>
              <b>{p.yearlyPriceInr === null ? 'Not set' : `₹${p.yearlyPriceInr}`}</b>
            </div>
            <div className="sr-status-row">
              <span>Evidence storage</span>
              <b>{Math.round(p.evidenceStorageMb / 1024)} GB</b>
            </div>
            <div className="sr-status-row">
              <span>On sale</span>
              <span className={`sr-badge ${p.onSale ? 'ok' : 'off'}`}>
                {p.onSale ? 'Yes' : 'No'}
              </span>
            </div>
            <div className="sr-status-row">
              <span>Active subscribers</span>
              <b>{p.activeSubscribers}</b>
            </div>
            <ul style={{ paddingLeft: 18, marginTop: 8 }}>
              {p.features.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
            <Button onClick={() => setEditing(p)}>Edit</Button>
          </SectionCard>
        ))}
      </div>
      <SectionCard title="Subscribers">
        {subs.isPending ? (
          <LoadingState />
        ) : subs.isError ? (
          <ErrorState onRetry={() => void subs.refetch()} />
        ) : (
          <Table
            className="sr-table"
            rowKey="id"
            dataSource={subs.data.items}
            pagination={false}
            columns={[
              {
                title: 'Started',
                key: 'c',
                render: (_: unknown, r: SubRow) => formatTimeShort(r.createdAt),
              },
              {
                title: 'User',
                key: 'u',
                render: (_: unknown, r: SubRow) => r.phone ?? 'Deleted account',
              },
              { title: 'Plan', dataIndex: 'plan', key: 'p' },
              { title: 'Status', dataIndex: 'status', key: 's' },
              {
                title: 'Renews',
                key: 'r',
                render: (_: unknown, r: SubRow) => (r.renewsAt ? formatTimeShort(r.renewsAt) : '—'),
              },
            ]}
            locale={{
              emptyText: (
                <EmptyState
                  icon="inbox"
                  title="No subscribers yet"
                  text="Purchases made through Google Play appear here. Refunds are done in Google Play Console."
                />
              ),
            }}
          />
        )}
      </SectionCard>
      {editing && <PlanDrawer plan={editing} onClose={() => setEditing(null)} />}
    </>
  );
}

function PlanDrawer({ plan, onClose }: { plan: PlanRow; onClose: () => void }) {
  const qc = useQueryClient();
  const [v, setV] = useState({ ...plan, featuresText: plan.features.join('\n') });
  const save = useMutation({
    mutationFn: () =>
      api('/admin/plans/' + plan.id, {
        method: 'PUT',
        body: {
          name: v.name,
          monthlyPriceInr: v.monthlyPriceInr,
          yearlyPriceInr: v.yearlyPriceInr,
          monthlyProductId: v.monthlyProductId || null,
          yearlyProductId: v.yearlyProductId || null,
          features: v.featuresText
            .split('\n')
            .map((f) => f.trim())
            .filter(Boolean),
          evidenceStorageMb: v.evidenceStorageMb,
          onSale: v.onSale,
        },
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['plans'] });
      onClose();
    },
  });
  return (
    <Drawer
      open
      width={480}
      title={`Edit ${plan.name}`}
      onClose={onClose}
      extra={
        <Button type="primary" loading={save.isPending} onClick={() => save.mutate()}>
          Save
        </Button>
      }
    >
      <Space direction="vertical" style={{ width: '100%' }}>
        <Input
          addonBefore="Name"
          value={v.name}
          onChange={(e) => setV({ ...v, name: e.target.value })}
        />
        <InputNumber
          addonBefore="Monthly ₹"
          style={{ width: '100%' }}
          min={0}
          value={v.monthlyPriceInr}
          onChange={(n) => setV({ ...v, monthlyPriceInr: n })}
        />
        <InputNumber
          addonBefore="Yearly ₹"
          style={{ width: '100%' }}
          min={0}
          value={v.yearlyPriceInr}
          onChange={(n) => setV({ ...v, yearlyPriceInr: n })}
        />
        <Input
          addonBefore="Play product (monthly)"
          value={v.monthlyProductId ?? ''}
          onChange={(e) => setV({ ...v, monthlyProductId: e.target.value })}
        />
        <Input
          addonBefore="Play product (yearly)"
          value={v.yearlyProductId ?? ''}
          onChange={(e) => setV({ ...v, yearlyProductId: e.target.value })}
        />
        <InputNumber
          addonBefore="Evidence storage MB"
          style={{ width: '100%' }}
          min={100}
          value={v.evidenceStorageMb}
          onChange={(n) => setV({ ...v, evidenceStorageMb: n ?? v.evidenceStorageMb })}
        />
        <Input.TextArea
          rows={5}
          value={v.featuresText}
          onChange={(e) => setV({ ...v, featuresText: e.target.value })}
          placeholder="One feature per line"
        />
        <Space>
          <Switch checked={v.onSale} onChange={(c) => setV({ ...v, onSale: c })} /> On sale in the
          app
        </Space>
        <p className="sr-muted">SOS, guardians and live location are never part of a paid plan.</p>
        {save.isError && <Alert type="error" showIcon message={errorText(save.error)} />}
      </Space>
    </Drawer>
  );
}

// ---- Reports: Phase 2 counts --------------------------------------------------------------------

interface Stats {
  sosByTrigger: Record<string, number>;
  falseAlarmsByTrigger: Record<string, number>;
  users: number;
  fullDayLocationUsers: number;
  fullDayLocationRate: number;
  vaultUsers: number;
  turnedOn: {
    shake: number;
    voice: number;
    driveMode: number;
    fall: number;
    quietCountdown: number;
  };
}

const TRIGGER: [string, string][] = [
  ['shake', 'Shake'],
  ['voice', 'Voice'],
  ['crash', 'Crash detection'],
  ['fall', 'Fall detection'],
  ['discreet', 'Discreet widget'],
];

export function Phase2Stats() {
  const [days, setDays] = useState(30);
  const stats = useQuery({
    queryKey: ['phase2-stats', days],
    queryFn: () => api<Stats>(`/admin/phase2/stats?days=${days}`),
  });
  return (
    <SectionCard title="New ways to raise SOS · full-day location · vault (counts only)">
      <div className="sr-filters">
        <Segmented
          value={days}
          onChange={(d) => setDays(Number(d))}
          options={[
            { value: 7, label: '7 days' },
            { value: 30, label: '30 days' },
            { value: 90, label: '90 days' },
          ]}
        />
      </div>
      {stats.isPending ? (
        <LoadingState />
      ) : stats.isError ? (
        <ErrorState onRetry={() => void stats.refetch()} />
      ) : (
        <>
          <Table
            className="sr-table"
            rowKey="0"
            pagination={false}
            dataSource={TRIGGER}
            columns={[
              { title: 'Trigger', key: 'n', render: (_: unknown, r: [string, string]) => r[1] },
              {
                title: 'SOS sent',
                key: 's',
                render: (_: unknown, r: [string, string]) => stats.data.sosByTrigger[r[0]] ?? 0,
              },
              {
                title: 'Cancelled (false alarm)',
                key: 'f',
                render: (_: unknown, r: [string, string]) =>
                  stats.data.falseAlarmsByTrigger[r[0]] ?? 0,
              },
            ]}
          />
          <div className="sr-stat-grid" style={{ marginTop: 16 }}>
            <div className="sr-stat">
              <span>Full-day location on</span>
              <b>
                {stats.data.fullDayLocationUsers} ({stats.data.fullDayLocationRate}%)
              </b>
            </div>
            <div className="sr-stat">
              <span>Users with a vault</span>
              <b>{stats.data.vaultUsers}</b>
            </div>
            <div className="sr-stat">
              <span>Shake SOS on</span>
              <b>{stats.data.turnedOn.shake}</b>
            </div>
            <div className="sr-stat">
              <span>Voice SOS on</span>
              <b>{stats.data.turnedOn.voice}</b>
            </div>
            <div className="sr-stat">
              <span>Drive mode on</span>
              <b>{stats.data.turnedOn.driveMode}</b>
            </div>
            <div className="sr-stat">
              <span>Fall detection on</span>
              <b>{stats.data.turnedOn.fall}</b>
            </div>
          </div>
        </>
      )}
    </SectionCard>
  );
}

// ---- User profile: Phase 2 ------------------------------------------------------------------------

interface UserPhase2 {
  sosTriggers: {
    shakeMode: 'off' | 'journey' | 'always';
    voiceOn: boolean;
    driveMode: boolean;
    fallOn: boolean;
    quietCountdown: boolean;
  };
  fullDayLocation: { enabled: boolean; paused: boolean; retentionDays: number };
  evidence: {
    vaultSetUpAt: string | null;
    items: number;
    sizeBytes: number;
    byKind: Record<string, number>;
    incidents: Record<string, number>;
    latest: {
      id: string;
      kind: string;
      sizeBytes: number;
      sha256: string;
      capturedAt: string;
      receivedAt: string;
      inIncident: boolean;
      uploaded: boolean;
    }[];
  };
  rakshak: { status: string; area: string; appliedAt: string } | null;
  communityReports: Record<string, number>;
}

const EVIDENCE_KIND: Record<string, string> = {
  audio: 'Audio',
  video: 'Video',
  photo: 'Photo',
  file: 'File',
  detail: 'Details (number, link…)',
  report: 'Report (PDF)',
};
const SHAKE: Record<UserPhase2['sosTriggers']['shakeMode'], string> = {
  off: 'Off',
  journey: 'On journeys',
  always: 'Always',
};
const RAKSHAK_STATUS: Record<string, string> = {
  under_review: 'Under review',
  approved: 'Approved',
  rejected: 'Not approved',
  withdrawn: 'Withdrawn',
};

export function bytesText(n: number): string {
  if (n >= 1024 * 1024 * 1024) return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n === 0) return '—';
  return `${Math.ceil(n / 1024)} KB`;
}

function OnOff({ on, label }: { on: boolean; label: string }) {
  return (
    <div className="sr-status-row">
      <span>{label}</span>
      {on ? <span className="sr-badge ok">On</span> : <span className="sr-badge off">Off</span>}
    </div>
  );
}

/** The Phase 2 cards on a user's profile (Users → a user). */
export function UserPhase2Cards({ userId }: { userId: string }) {
  const q = useQuery({
    queryKey: ['user-phase2', userId],
    queryFn: () => api<UserPhase2>(`/admin/users/${userId}/phase2`),
  });
  if (q.isLoading) return <LoadingState />;
  if (q.isError || !q.data) return <ErrorState onRetry={() => void q.refetch()} />;
  const d = q.data;
  const ev = d.evidence;
  const kinds = Object.entries(ev.byKind)
    .map(([k, n]) => `${EVIDENCE_KIND[k] ?? k}: ${n}`)
    .join(' · ');
  const incidents = Object.values(ev.incidents).reduce((s, n) => s + n, 0);
  const reports = Object.entries(d.communityReports)
    .map(([s, n]) => `${s}: ${n}`)
    .join(' · ');

  return (
    <>
      <div className="sr-cols">
        <SectionCard title="SOS triggers">
          <div className="sr-status-list">
            <div className="sr-status-row">
              <span>Shake to SOS</span>
              <span className={`sr-badge ${d.sosTriggers.shakeMode === 'off' ? 'off' : 'ok'}`}>
                {SHAKE[d.sosTriggers.shakeMode]}
              </span>
            </div>
            <OnOff on={d.sosTriggers.voiceOn} label="Voice SOS" />
            <OnOff on={d.sosTriggers.driveMode} label="Drive mode (crash)" />
            <OnOff on={d.sosTriggers.fallOn} label="Fall detection" />
            <OnOff on={d.sosTriggers.quietCountdown} label="Quiet countdown" />
          </div>
        </SectionCard>
        <SectionCard title="Other features">
          <div className="sr-status-list">
            <div className="sr-status-row">
              <span>Full-day location</span>
              <span
                className={`sr-badge ${d.fullDayLocation.enabled && !d.fullDayLocation.paused ? 'ok' : 'off'}`}
              >
                {!d.fullDayLocation.enabled
                  ? 'Off'
                  : d.fullDayLocation.paused
                    ? 'Paused'
                    : `On · kept ${d.fullDayLocation.retentionDays} days`}
              </span>
            </div>
            <div className="sr-status-row">
              <span>Rakshak application</span>
              <span>
                {d.rakshak
                  ? `${RAKSHAK_STATUS[d.rakshak.status] ?? d.rakshak.status} · ${d.rakshak.area}`
                  : 'None'}
              </span>
            </div>
            <div className="sr-status-row">
              <span>Community reports</span>
              <span>{reports || 'None'}</span>
            </div>
          </div>
          <p className="sr-muted">Where the user goes is never shown to admins.</p>
        </SectionCard>
      </div>

      <SectionCard title="Mere Saboot (evidence)">
        <Alert
          type="info"
          showIcon
          message="Encrypted on the user's phone"
          description="You can see that evidence was recorded, but not what is in it. Only the user who recorded it can open it: the app and the server never have the key."
          style={{ marginBottom: 16 }}
        />
        <Descriptions
          size="small"
          column={{ xs: 1, md: 2 }}
          items={[
            {
              key: 'vault',
              label: 'Vault',
              children: ev.vaultSetUpAt
                ? `Set up ${formatTimeShort(ev.vaultSetUpAt)}`
                : 'Not set up',
            },
            { key: 'items', label: 'Items', children: ev.items },
            { key: 'size', label: 'Storage used', children: bytesText(ev.sizeBytes) },
            { key: 'incidents', label: 'Incidents', children: incidents },
            { key: 'kinds', label: 'By type', children: kinds || '—' },
          ]}
        />
        <Table
          className="sr-table"
          rowKey="id"
          size="small"
          style={{ marginTop: 12 }}
          pagination={false}
          scroll={{ x: 'max-content' }}
          dataSource={ev.latest}
          columns={[
            {
              title: 'Type',
              key: 'kind',
              render: (_: unknown, r: UserPhase2['evidence']['latest'][number]) =>
                EVIDENCE_KIND[r.kind] ?? r.kind,
            },
            {
              title: 'Recorded',
              key: 'captured',
              render: (_: unknown, r: UserPhase2['evidence']['latest'][number]) => (
                <span className="sr-mono">{formatTimeShort(r.capturedAt)}</span>
              ),
            },
            {
              title: 'Received by server',
              key: 'received',
              render: (_: unknown, r: UserPhase2['evidence']['latest'][number]) => (
                <span className="sr-mono">{formatTimeShort(r.receivedAt)}</span>
              ),
            },
            {
              title: 'Size',
              key: 'size',
              render: (_: unknown, r: UserPhase2['evidence']['latest'][number]) =>
                bytesText(r.sizeBytes),
            },
            {
              title: 'Fingerprint (SHA-256)',
              key: 'sha',
              render: (_: unknown, r: UserPhase2['evidence']['latest'][number]) => (
                <span className="sr-mono" title={r.sha256}>
                  {r.sha256.slice(0, 12)}…
                </span>
              ),
            },
            {
              title: 'Content',
              key: 'content',
              render: () => <span className="sr-badge off">Encrypted</span>,
            },
          ]}
          locale={{
            emptyText: (
              <EmptyState
                icon="list"
                title="No evidence"
                text="Items the user saves appear here (content stays encrypted)."
              />
            ),
          }}
        />
      </SectionCard>
    </>
  );
}
