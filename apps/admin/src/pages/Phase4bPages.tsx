import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Form, Input, InputNumber, Modal, Segmented, Select, Space, Switch, Table, Tag } from 'antd';
import { useState } from 'react';
import { api, ApiError } from '../api';
import { useMe } from '../auth/session';
import { EmptyState, ErrorState, LoadingState, SectionCard } from '../components/states';
import { formatTimeShort } from '../format';

// Phase 4 integrations screen: Schools, Smart Glasses registry, Safety data (scoring), Police / ERSS
// endpoints and attempts, and the Family tab (Chhupa Rakshak sessions and Cyberbullying counts).
// Private content is never shown here: no locations, no message text, no vault content.
// Every view and action is written to the audit log by the server.

type Tab = 'schools' | 'glasses' | 'safety' | 'authority' | 'family';

const errorText = (e: unknown) =>
  e instanceof ApiError
    ? (e.serverMessage ?? 'Something went wrong. Please try again.')
    : 'Something went wrong. Please try again.';

export function SafetyIntegrationsBody() {
  const [tab, setTab] = useState<Tab>('schools');
  const me = useMe();
  const isSuper = me.data?.role === 'super_admin';
  return (
    <>
      <div className="sr-filters">
        <Segmented
          value={tab}
          onChange={(v) => setTab(v as Tab)}
          options={[
            { value: 'schools', label: 'Schools' },
            { value: 'glasses', label: 'Smart glasses' },
            { value: 'safety', label: 'Safety data' },
            ...(isSuper ? [{ value: 'authority', label: 'Police / ERSS' }] : []),
            { value: 'family', label: 'Family' },
          ]}
        />
      </div>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="Nothing here is shown to the app until its switch is on in Settings. Locations, message text and vault content are never shown on this screen. Every view and action is written to the audit log."
      />
      {tab === 'schools' && <Schools isSuper={isSuper} />}
      {tab === 'glasses' && <Glasses isSuper={isSuper} />}
      {tab === 'safety' && <SafetyData isSuper={isSuper} />}
      {tab === 'authority' && isSuper && <Authority />}
      {tab === 'family' && <Family />}
    </>
  );
}

// ---- small helpers ---------------------------------------------------------------------------------

type FieldType = 'text' | 'number' | 'select' | 'textarea' | 'bool';
interface Field {
  name: string;
  label: string;
  type: FieldType;
  required?: boolean;
  options?: { value: string; label: string }[];
  initial?: unknown;
  hint?: string;
}

function FormModal({
  title,
  fields,
  open,
  onClose,
  onSubmit,
  okText = 'Save',
}: {
  title: string;
  fields: Field[];
  open: boolean;
  onClose: () => void;
  onSubmit: (values: Record<string, unknown>) => Promise<unknown>;
  okText?: string;
}) {
  const [form] = Form.useForm<Record<string, unknown>>();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    const values = await form.validateFields().catch(() => null);
    if (!values) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(values);
      form.resetFields();
      onClose();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={title}
      open={open}
      onCancel={onClose}
      onOk={() => void submit()}
      okText={okText}
      confirmLoading={busy}
      destroyOnHidden
    >
      <Form
        form={form}
        layout="vertical"
        initialValues={Object.fromEntries(fields.filter((f) => f.initial !== undefined).map((f) => [f.name, f.initial]))}
      >
        {fields.map((f) => (
          <Form.Item
            key={f.name}
            name={f.name}
            label={f.label}
            extra={f.hint}
            valuePropName={f.type === 'bool' ? 'checked' : 'value'}
            rules={f.required ? [{ required: true, message: `${f.label} is needed` }] : []}
          >
            {f.type === 'text' ? (
              <Input />
            ) : f.type === 'textarea' ? (
              <Input.TextArea rows={5} />
            ) : f.type === 'number' ? (
              <InputNumber style={{ width: '100%' }} />
            ) : f.type === 'bool' ? (
              <Switch />
            ) : (
              <Select options={f.options} />
            )}
          </Form.Item>
        ))}
        {error && <Alert type="error" message={error} showIcon />}
      </Form>
    </Modal>
  );
}

function useAction(invalidate: string[]) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ path, body, method }: { path: string; body?: object; method?: 'POST' | 'PUT' }) =>
      api<Record<string, unknown>>(path, { method: method ?? 'POST', body: body ?? {} }),
    onSuccess: () => {
      for (const k of invalidate) void qc.invalidateQueries({ queryKey: [k] });
    },
  });
}

function List<T extends { id?: string | number }>({
  queryKey,
  path,
  empty,
  columns,
  rowKey = 'id',
}: {
  queryKey: string;
  path: string;
  empty: { title: string; text: string };
  columns: object[];
  rowKey?: string;
}) {
  const q = useQuery({ queryKey: [queryKey], queryFn: () => api<{ items: T[] }>(path) });
  if (q.isPending) return <LoadingState />;
  if (q.isError) return <ErrorState onRetry={() => void q.refetch()} />;
  if (q.data.items.length === 0) return <EmptyState icon="inbox" title={empty.title} text={empty.text} />;
  return (
    <Table
      className="sr-table"
      rowKey={rowKey}
      dataSource={q.data.items}
      pagination={false}
      scroll={{ x: 'max-content' }}
      columns={columns}
    />
  );
}

const when = (v: string | null) => (v ? formatTimeShort(v) : '—');

// ---- Schools -----------------------------------------------------------------------------------------

interface SchoolRow {
  id: string; code: string; name: string; city: string | null; status: string; keyVersion: number;
  lastEventAt: string | null; staleFeed: boolean; events: number; rejected: number; activeLinks: number;
}

function Schools({ isSuper }: { isSuper: boolean }) {
  const [adding, setAdding] = useState(false);
  const act = useAction(['p4b-schools', 'p4b-school-links', 'p4b-quarantine']);
  const [secret, setSecret] = useState<{ code: string; secret: string } | null>(null);
  const run = (path: string, body?: object) => act.mutateAsync({ path, body });
  return (
    <>
      <div className="sr-filters">
        {isSuper && <Button type="primary" onClick={() => setAdding(true)}>Add school</Button>}
      </div>
      <SectionCard title="Schools">
        <List<SchoolRow>
          queryKey="p4b-schools"
          path="/admin/phase4b/schools"
          empty={{ title: 'No schools yet', text: 'Add a school, then verify it so it can send attendance events.' }}
          columns={[
            { title: 'Code', dataIndex: 'code', key: 'c' },
            { title: 'School', dataIndex: 'name', key: 'n' },
            { title: 'Status', key: 's', render: (_: unknown, r: SchoolRow) => <Tag color={r.status === 'verified' ? 'green' : r.status === 'suspended' ? 'red' : 'gold'}>{r.status}</Tag> },
            { title: 'Last event', key: 'l', render: (_: unknown, r: SchoolRow) => (r.staleFeed ? <Tag color="orange">Stale feed</Tag> : null) ?? when(r.lastEventAt) },
            { title: 'Active links', dataIndex: 'activeLinks', key: 'al' },
            { title: 'Events', dataIndex: 'events', key: 'e' },
            { title: 'Rejected', dataIndex: 'rejected', key: 'r' },
            { title: 'Key', key: 'k', render: (_: unknown, r: SchoolRow) => `v${r.keyVersion}` },
            {
              title: '',
              key: 'a',
              render: (_: unknown, r: SchoolRow) =>
                isSuper ? (
                  <Space>
                    {r.status !== 'verified' && <Button size="small" onClick={() => void run(`/admin/phase4b/schools/${r.id}/status`, { status: 'verified' })}>Verify</Button>}
                    {r.status === 'verified' && <Button size="small" danger onClick={() => void run(`/admin/phase4b/schools/${r.id}/status`, { status: 'suspended' })}>Suspend</Button>}
                    <Button
                      size="small"
                      onClick={() =>
                        Modal.confirm({
                          title: 'Rotate the signing key?',
                          content: 'The old key stops working at once. The new key is shown one time only.',
                          onOk: async () => {
                            const res = await run(`/admin/phase4b/schools/${r.id}/rotate-key`);
                            setSecret({ code: r.code, secret: String(res.secret) });
                          },
                        })
                      }
                    >
                      Rotate key
                    </Button>
                  </Space>
                ) : null,
            },
          ]}
        />
      </SectionCard>
      <SectionCard title="Link requests from parents">
        <List<{ id: string; childName: string; studentRef: string; status: string; schoolName: string; createdAt: string }>
          queryKey="p4b-school-links"
          path="/admin/phase4b/school-links"
          empty={{ title: 'No link requests', text: 'Parents appear here when they ask to link a child to a verified school.' }}
          columns={[
            { title: 'Child', dataIndex: 'childName', key: 'c' },
            { title: 'Student ref', dataIndex: 'studentRef', key: 'sr' },
            { title: 'School', dataIndex: 'schoolName', key: 's' },
            { title: 'Status', dataIndex: 'status', key: 'st', render: (v: string) => <Tag>{v}</Tag> },
            { title: 'Asked', key: 'a', render: (_: unknown, r: { createdAt: string }) => when(r.createdAt) },
            {
              title: '',
              key: 'x',
              render: (_: unknown, r: { id: string; status: string }) => (
                <Space>
                  {r.status !== 'active' && <Button size="small" type="primary" onClick={() => void run(`/admin/phase4b/school-links/${r.id}/decision`, { status: 'active' })}>Confirm</Button>}
                  {r.status !== 'rejected' && <Button size="small" onClick={() => void run(`/admin/phase4b/school-links/${r.id}/decision`, { status: 'rejected', note: 'The school could not confirm this child.' })}>Reject</Button>}
                </Space>
              ),
            },
          ]}
        />
      </SectionCard>
      <SectionCard title="Rejected events (quarantine)">
        <List<{ id: number; school: string | null; errorType: string; detail: string | null; receivedAt: string }>
          queryKey="p4b-quarantine"
          path="/admin/phase4b/school-quarantine"
          empty={{ title: 'Nothing rejected', text: 'Events with a bad signature, format or child mapping are kept here with the reason.' }}
          columns={[
            { title: 'When', key: 'w', render: (_: unknown, r: { receivedAt: string }) => when(r.receivedAt) },
            { title: 'School', key: 's', render: (_: unknown, r: { school: string | null }) => r.school ?? '—' },
            { title: 'Error', dataIndex: 'errorType', key: 'e' },
            { title: 'Detail', key: 'd', render: (_: unknown, r: { detail: string | null }) => r.detail ?? '—' },
          ]}
        />
      </SectionCard>
      <FormModal
        title="Add a school"
        open={adding}
        onClose={() => setAdding(false)}
        fields={[
          { name: 'code', label: 'School code', type: 'text', required: true, hint: '4 to 20 letters, numbers or dashes' },
          { name: 'name', label: 'Name', type: 'text', required: true },
          { name: 'city', label: 'City', type: 'text' },
        ]}
        onSubmit={async (v) => {
          const res = await run('/admin/phase4b/schools', v);
          setSecret({ code: String(v.code).toUpperCase(), secret: String(res.secret) });
        }}
      />
      <Modal title="Signing key (shown once)" open={secret !== null} onOk={() => setSecret(null)} onCancel={() => setSecret(null)} cancelButtonProps={{ style: { display: 'none' } }}>
        <p>Give this key to {secret?.code} through a safe channel. It cannot be shown again.</p>
        <Input.TextArea readOnly rows={2} value={secret?.secret} />
      </Modal>
    </>
  );
}

// ---- Smart glasses -----------------------------------------------------------------------------------

interface ModelRow {
  id: string; manufacturer: string; model: string; minFirmware: string; sdkVersion: string | null;
  capabilities: string[]; knownLimits: string | null; supported: boolean; pairedDevices: number;
}

function Glasses({ isSuper }: { isSuper: boolean }) {
  const [editing, setEditing] = useState<ModelRow | 'new' | null>(null);
  const act = useAction(['p4b-glasses']);
  const m = editing && editing !== 'new' ? editing : null;
  return (
    <>
      <div className="sr-filters">
        {isSuper && <Button type="primary" onClick={() => setEditing('new')}>Add model</Button>}
      </div>
      <SectionCard title="Supported smart glasses">
        <List<ModelRow>
          queryKey="p4b-glasses"
          path="/admin/phase4b/glasses-models"
          empty={{ title: 'No models yet', text: 'Add a model only when the hardware and its SDK have been supplied. The app never claims to work with every device.' }}
          columns={[
            { title: 'Maker', dataIndex: 'manufacturer', key: 'm' },
            { title: 'Model', dataIndex: 'model', key: 'mo' },
            { title: 'Min firmware', dataIndex: 'minFirmware', key: 'f' },
            { title: 'SDK', key: 'sd', render: (_: unknown, r: ModelRow) => r.sdkVersion ?? '—' },
            { title: 'Capabilities', key: 'c', render: (_: unknown, r: ModelRow) => r.capabilities.join(', ') || '—' },
            { title: 'Known limits', key: 'k', render: (_: unknown, r: ModelRow) => r.knownLimits ?? '—' },
            { title: 'Supported', key: 's', render: (_: unknown, r: ModelRow) => <Tag color={r.supported ? 'green' : 'red'}>{r.supported ? 'Yes' : 'No'}</Tag> },
            { title: 'Paired', dataIndex: 'pairedDevices', key: 'p' },
            { title: '', key: 'a', render: (_: unknown, r: ModelRow) => (isSuper ? <Button size="small" onClick={() => setEditing(r)}>Edit</Button> : null) },
          ]}
        />
      </SectionCard>
      <FormModal
        key={m?.id ?? 'new'}
        title={m ? 'Edit model' : 'Add model'}
        open={editing !== null}
        onClose={() => setEditing(null)}
        fields={[
          { name: 'manufacturer', label: 'Manufacturer', type: 'text', required: true, initial: m?.manufacturer },
          { name: 'model', label: 'Model', type: 'text', required: true, initial: m?.model },
          { name: 'minFirmware', label: 'Minimum firmware', type: 'text', required: true, initial: m?.minFirmware },
          { name: 'sdkVersion', label: 'SDK version', type: 'text', initial: m?.sdkVersion ?? undefined },
          { name: 'capabilities', label: 'Capabilities (comma separated)', type: 'text', initial: m?.capabilities.join(', ') },
          { name: 'knownLimits', label: 'Known limits', type: 'text', initial: m?.knownLimits ?? undefined },
          { name: 'supported', label: 'Supported', type: 'bool', initial: m?.supported ?? true },
        ]}
        onSubmit={(v) =>
          act.mutateAsync({
            path: m ? `/admin/phase4b/glasses-models/${m.id}` : '/admin/phase4b/glasses-models',
            method: m ? 'PUT' : 'POST',
            body: { ...v, capabilities: ((v.capabilities as string | undefined) ?? '').split(',').map((s) => s.trim()).filter(Boolean) },
          })
        }
      />
    </>
  );
}

// ---- Safety data -------------------------------------------------------------------------------------

function SafetyData({ isSuper }: { isSuper: boolean }) {
  const act = useAction(['p4b-datasets', 'p4b-models', 'p4b-feedback']);
  const [dataset, setDataset] = useState(false);
  const [model, setModel] = useState(false);
  const [importing, setImporting] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const run = (path: string, body?: object) => act.mutateAsync({ path, body });
  return (
    <>
      <Alert type="warning" showIcon style={{ marginBottom: 16 }} message="Scores are advice based on the data below. Weights, datasets and refresh times are your decision: every change is logged, and old model versions are kept." />
      <div className="sr-filters">{isSuper && <Button type="primary" onClick={() => setDataset(true)}>Add dataset</Button>}</div>
      <SectionCard title="Datasets">
        <List<{ id: string; name: string; kind: string; source: string; licence: string; refreshDays: number; status: string; lastImportedAt: string | null; records: number; stale: boolean }>
          queryKey="p4b-datasets"
          path="/admin/phase4b/safety/datasets"
          empty={{ title: 'No datasets yet', text: 'No data means every route shows "unknown". It is never treated as safe.' }}
          columns={[
            { title: 'Name', dataIndex: 'name', key: 'n' },
            { title: 'Kind', dataIndex: 'kind', key: 'k' },
            { title: 'Source', dataIndex: 'source', key: 's' },
            { title: 'Licence', dataIndex: 'licence', key: 'l' },
            { title: 'Status', key: 'st', render: (_: unknown, r: { status: string; stale: boolean }) => <Space><Tag color={r.status === 'active' ? 'green' : 'default'}>{r.status}</Tag>{r.stale && <Tag color="orange">Stale</Tag>}</Space> },
            { title: 'Records', dataIndex: 'records', key: 'r' },
            { title: 'Last import', key: 'li', render: (_: unknown, r: { lastImportedAt: string | null }) => when(r.lastImportedAt) },
            {
              title: '',
              key: 'a',
              render: (_: unknown, r: { id: string; status: string }) =>
                isSuper ? (
                  <Space>
                    <Button size="small" onClick={() => setImporting(r.id)}>Import</Button>
                    <Button size="small" onClick={() => void run(`/admin/phase4b/safety/datasets/${r.id}/status`, { status: r.status === 'active' ? 'paused' : 'active' })}>
                      {r.status === 'active' ? 'Pause' : 'Make active'}
                    </Button>
                  </Space>
                ) : null,
            },
          ]}
        />
      </SectionCard>
      <div className="sr-filters">{isSuper && <Button onClick={() => setModel(true)}>Add model version</Button>}</div>
      <SectionCard title="Scoring models">
        <List<{ id: string; version: string; active: boolean; createdAt: string }>
          queryKey="p4b-models"
          path="/admin/phase4b/safety/models"
          empty={{ title: 'No models', text: 'A model is needed to score routes.' }}
          columns={[
            { title: 'Version', dataIndex: 'version', key: 'v' },
            { title: 'Active', key: 'a', render: (_: unknown, r: { active: boolean }) => (r.active ? <Tag color="green">Active</Tag> : '—') },
            { title: 'Added', key: 'c', render: (_: unknown, r: { createdAt: string }) => when(r.createdAt) },
            { title: '', key: 'x', render: (_: unknown, r: { id: string; active: boolean }) => (isSuper && !r.active ? <Button size="small" onClick={() => void run(`/admin/phase4b/safety/models/${r.id}/activate`)}>Make active</Button> : null) },
          ]}
        />
      </SectionCard>
      <SectionCard title="Route feedback from users">
        <List<{ id: string; kind: string; message: string; status: string; createdAt: string }>
          queryKey="p4b-feedback"
          path="/admin/phase4b/safety/feedback"
          empty={{ title: 'No feedback', text: 'Reports about inaccurate routes appear here. They are not treated as verified incident data.' }}
          columns={[
            { title: 'When', key: 'w', render: (_: unknown, r: { createdAt: string }) => when(r.createdAt) },
            { title: 'Kind', dataIndex: 'kind', key: 'k' },
            { title: 'Message', dataIndex: 'message', key: 'm' },
            { title: 'Status', dataIndex: 'status', key: 's', render: (v: string) => <Tag>{v}</Tag> },
            {
              title: '',
              key: 'a',
              render: (_: unknown, r: { id: string; status: string }) =>
                r.status === 'new' ? (
                  <Space>
                    <Button size="small" onClick={() => void run(`/admin/phase4b/safety/feedback/${r.id}/review`, { status: 'reviewed' })}>Reviewed</Button>
                    <Button size="small" onClick={() => void run(`/admin/phase4b/safety/feedback/${r.id}/review`, { status: 'actioned' })}>Actioned</Button>
                    <Button size="small" onClick={() => void run(`/admin/phase4b/safety/feedback/${r.id}/review`, { status: 'rejected' })}>Reject</Button>
                  </Space>
                ) : null,
            },
          ]}
        />
      </SectionCard>
      <FormModal
        title="Add a dataset"
        open={dataset}
        onClose={() => setDataset(false)}
        fields={[
          { name: 'name', label: 'Name', type: 'text', required: true },
          { name: 'kind', label: 'Kind', type: 'select', required: true, options: ['incident', 'lighting', 'activity', 'support_point'].map((v) => ({ value: v, label: v })) },
          { name: 'source', label: 'Source', type: 'text', required: true },
          { name: 'licence', label: 'Licence', type: 'text', required: true },
          { name: 'refreshDays', label: 'Refresh every (days)', type: 'number', initial: 90 },
        ]}
        onSubmit={(v) => run('/admin/phase4b/safety/datasets', v)}
      />
      <FormModal
        title="Import records"
        okText="Import"
        open={importing !== null}
        onClose={() => setImporting(null)}
        fields={[{ name: 'json', label: 'Records (JSON list)', type: 'textarea', required: true, hint: 'Each: {"lat":28.57,"lng":77.32,"category":"incident","weight":0.8,"sourceTime":"2026-10-01T00:00:00Z"}' }]}
        onSubmit={async (v) => {
          let records: unknown;
          try {
            records = JSON.parse(String(v.json));
          } catch {
            throw new ApiError(400, { message: 'That is not valid JSON.' });
          }
          const res = await run(`/admin/phase4b/safety/datasets/${importing}/import`, { records });
          setResult(`Accepted ${String(res.accepted)}, rejected ${String(res.rejected)} (rejected rows are kept with the reason).`);
        }}
      />
      <FormModal
        title="Add a model version"
        open={model}
        onClose={() => setModel(false)}
        fields={[
          { name: 'version', label: 'Version name', type: 'text', required: true },
          { name: 'json', label: 'Configuration (JSON)', type: 'textarea', required: true, hint: 'radiusM, sampleEveryM, minCoverage, categoryWeights, halfLifeDays, bands' },
          { name: 'activate', label: 'Make it the active model', type: 'bool' },
        ]}
        onSubmit={async (v) => {
          let config: unknown;
          try {
            config = JSON.parse(String(v.json));
          } catch {
            throw new ApiError(400, { message: 'That is not valid JSON.' });
          }
          await run('/admin/phase4b/safety/models', { version: v.version, activate: v.activate === true, config });
        }}
      />
      <Modal open={result !== null} onOk={() => setResult(null)} onCancel={() => setResult(null)} title="Import finished" cancelButtonProps={{ style: { display: 'none' } }}>
        {result}
      </Modal>
    </>
  );
}

// ---- Police / ERSS -----------------------------------------------------------------------------------

interface EndpointRow {
  id: string; name: string; kind: string; jurisdiction: string; environment: string; baseUrl: string; credentialEnv: string;
  credentialConfigured: boolean; credentialExpiresAt: string | null; permittedOps: string[]; permittedFields: string[];
  enabled: boolean; sandboxPassed: boolean; lastHealthAt: string | null; lastHealthOk: boolean | null;
}

function Authority() {
  const act = useAction(['p4b-endpoints', 'p4b-attempts', 'p4b-queries']);
  const [adding, setAdding] = useState(false);
  const [ack, setAck] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const run = async (path: string, body?: object) => {
    try {
      return await act.mutateAsync({ path, body });
    } catch (e) {
      setMessage(errorText(e));
      return null;
    }
  };
  return (
    <>
      <Alert type="warning" showIcon style={{ marginBottom: 16 }} message="Only add an endpoint that the authority approved in writing. Secrets live in the server settings: here you only name them. SOS always works without this, and the app never says police were dispatched unless the authority confirms." />
      <div className="sr-filters"><Button type="primary" onClick={() => setAdding(true)}>Add endpoint</Button></div>
      <SectionCard title="Authority endpoints">
        <List<EndpointRow>
          queryKey="p4b-endpoints"
          path="/admin/phase4b/authority/endpoints"
          empty={{ title: 'No endpoints', text: 'Until one is approved, SOS stays on its own with Call 112 as the fallback.' }}
          columns={[
            { title: 'Name', dataIndex: 'name', key: 'n' },
            { title: 'Type', dataIndex: 'kind', key: 'k', render: (v: string) => v.toUpperCase() },
            { title: 'Jurisdiction', dataIndex: 'jurisdiction', key: 'j' },
            { title: 'Environment', dataIndex: 'environment', key: 'e', render: (v: string) => <Tag color={v === 'production' ? 'red' : 'blue'}>{v}</Tag> },
            { title: 'Secret', key: 'sc', render: (_: unknown, r: EndpointRow) => <span>{r.credentialEnv} {r.credentialConfigured ? <Tag color="green">set</Tag> : <Tag color="red">missing</Tag>}</span> },
            { title: 'Expires', key: 'x', render: (_: unknown, r: EndpointRow) => when(r.credentialExpiresAt) },
            { title: 'Sandbox passed', key: 'sp', render: (_: unknown, r: EndpointRow) => (r.sandboxPassed ? 'Yes' : 'No') },
            { title: 'Health', key: 'h', render: (_: unknown, r: EndpointRow) => (r.lastHealthOk === null ? '—' : <Tag color={r.lastHealthOk ? 'green' : 'red'}>{r.lastHealthOk ? 'OK' : 'Down'}</Tag>) },
            { title: 'Enabled', key: 'en', render: (_: unknown, r: EndpointRow) => <Switch checked={r.enabled} onChange={(v) => void run(`/admin/phase4b/authority/endpoints/${r.id}/enabled`, { enabled: v })} /> },
            {
              title: '',
              key: 'a',
              render: (_: unknown, r: EndpointRow) => (
                <Space>
                  <Button size="small" onClick={() => void run(`/admin/phase4b/authority/endpoints/${r.id}/health`)}>Check health</Button>
                  {!r.sandboxPassed && <Button size="small" onClick={() => void run(`/admin/phase4b/authority/endpoints/${r.id}/sandbox-passed`)}>Sandbox passed</Button>}
                </Space>
              ),
            },
          ]}
        />
      </SectionCard>
      <SectionCard title="Handoff attempts">
        <List<{ id: string; sosId: string; status: string; errorType: string | null; attempts: number; deadLetter: boolean; payloadVersion: string; responseRef: string | null; endpoint: string | null; createdAt: string }>
          queryKey="p4b-attempts"
          path="/admin/phase4b/authority/attempts"
          empty={{ title: 'No attempts yet', text: 'Each SOS handoff appears here with its true status.' }}
          columns={[
            { title: 'When', key: 'w', render: (_: unknown, r: { createdAt: string }) => when(r.createdAt) },
            { title: 'Endpoint', key: 'e', render: (_: unknown, r: { endpoint: string | null }) => r.endpoint ?? 'None (Call 112)' },
            { title: 'Status', key: 's', render: (_: unknown, r: { status: string; deadLetter: boolean }) => <Space><Tag>{r.status}</Tag>{r.deadLetter && <Tag color="red">Dead letter</Tag>}</Space> },
            { title: 'Error', key: 'er', render: (_: unknown, r: { errorType: string | null }) => r.errorType ?? '—' },
            { title: 'Tries', dataIndex: 'attempts', key: 't' },
            { title: 'Reference', key: 'rf', render: (_: unknown, r: { responseRef: string | null }) => r.responseRef ?? '—' },
            {
              title: '',
              key: 'a',
              render: (_: unknown, r: { id: string; status: string }) => (
                <Space>
                  {!['accepted', 'acknowledged', 'fallback'].includes(r.status) && <Button size="small" onClick={() => void run(`/admin/phase4b/authority/attempts/${r.id}/fallback`)}>Manual fallback done</Button>}
                  {r.status === 'accepted' && <Button size="small" onClick={() => setAck(r.id)}>Authority confirmed</Button>}
                </Space>
              ),
            },
          ]}
        />
      </SectionCard>
      <SectionCard title="Verification queries (CCTNS)">
        <List<{ id: string; endpoint: string; purpose: string; fields: string[]; status: string; reference: string | null; createdAt: string }>
          queryKey="p4b-queries"
          path="/admin/phase4b/authority/queries"
          empty={{ title: 'No queries', text: 'Every verification query is listed here with its purpose. Field values are never stored.' }}
          columns={[
            { title: 'When', key: 'w', render: (_: unknown, r: { createdAt: string }) => when(r.createdAt) },
            { title: 'Endpoint', dataIndex: 'endpoint', key: 'e' },
            { title: 'Purpose', dataIndex: 'purpose', key: 'p' },
            { title: 'Fields sent', key: 'f', render: (_: unknown, r: { fields: string[] }) => r.fields.join(', ') },
            { title: 'Result', dataIndex: 'status', key: 's', render: (v: string) => <Tag color={v === 'verified' ? 'green' : 'default'}>{v}</Tag> },
          ]}
        />
      </SectionCard>
      <FormModal
        title="Add an authority endpoint"
        open={adding}
        onClose={() => setAdding(false)}
        fields={[
          { name: 'name', label: 'Name', type: 'text', required: true },
          { name: 'kind', label: 'Type', type: 'select', required: true, options: [{ value: 'erss', label: 'ERSS / Dial 112' }, { value: 'cctns', label: 'CCTNS verification' }] },
          { name: 'jurisdiction', label: 'Jurisdiction', type: 'text', required: true },
          { name: 'environment', label: 'Environment', type: 'select', required: true, options: [{ value: 'sandbox', label: 'Sandbox' }, { value: 'production', label: 'Production (https only)' }] },
          { name: 'baseUrl', label: 'Address', type: 'text', required: true },
          { name: 'credentialEnv', label: 'Secret name on the server', type: 'text', required: true, hint: 'e.g. ERSS_SANDBOX_TOKEN. The value is set in the server environment, never here.' },
          { name: 'credentialOwner', label: 'Credential owner', type: 'text', required: true },
          { name: 'credentialExpiresAt', label: 'Credential expires (ISO date, optional)', type: 'text' },
          { name: 'permittedOps', label: 'Permitted operations', type: 'select', required: true, options: [{ value: 'send_event', label: 'Send event (ERSS)' }, { value: 'verify', label: 'Verify (CCTNS)' }] },
          { name: 'permittedFields', label: 'Permitted fields (comma separated)', type: 'text', hint: 'ERSS: eventId, callbackNumber, location, accuracyM, time' },
        ]}
        onSubmit={(v) =>
          act.mutateAsync({
            path: '/admin/phase4b/authority/endpoints',
            body: {
              ...v,
              credentialExpiresAt: v.credentialExpiresAt ? (v.credentialExpiresAt as string) : null,
              permittedOps: [v.permittedOps],
              permittedFields: ((v.permittedFields as string | undefined) ?? '').split(',').map((s) => s.trim()).filter(Boolean),
            },
          })
        }
      />
      <FormModal
        title="The authority confirmed this"
        okText="Mark acknowledged"
        open={ack !== null}
        onClose={() => setAck(null)}
        fields={[{ name: 'reason', label: 'How they confirmed (kept in the audit log)', type: 'text', required: true }]}
        onSubmit={(v) => act.mutateAsync({ path: `/admin/phase4b/authority/attempts/${ack}/acknowledged`, body: v })}
      />
      <Modal open={message !== null} onOk={() => setMessage(null)} onCancel={() => setMessage(null)} title="Could not do that" cancelButtonProps={{ style: { display: 'none' } }}>
        {message}
      </Modal>
    </>
  );
}

// ---- Family: sessions and cyber counts ---------------------------------------------------------------

function Family() {
  const cyber = useQuery({ queryKey: ['p4b-cyber'], queryFn: () => api<{ enabledSources: number; flags: { category: string; status: string; count: number }[] }>('/admin/phase4b/cyber') });
  return (
    <>
      <SectionCard title="Chhupa Rakshak sessions (metadata only)">
        <List<{ id: string; status: string; endReason: string | null; startedAt: string; endedAt: string | null; minutes: number; views: number }>
          queryKey="p4b-sessions"
          path="/admin/phase4b/monitoring"
          empty={{ title: 'No sessions', text: 'Sessions appear here as a count and a time. Locations are never shown to admins.' }}
          columns={[
            { title: 'Started', key: 's', render: (_: unknown, r: { startedAt: string }) => when(r.startedAt) },
            { title: 'Status', dataIndex: 'status', key: 'st', render: (v: string) => <Tag>{v}</Tag> },
            { title: 'Ended because', key: 'e', render: (_: unknown, r: { endReason: string | null }) => r.endReason ?? '—' },
            { title: 'Minutes', dataIndex: 'minutes', key: 'm' },
            { title: 'Parent views', dataIndex: 'views', key: 'v' },
          ]}
        />
      </SectionCard>
      <SectionCard title="Cyberbullying flags (counts only)">
        {cyber.isPending ? (
          <LoadingState />
        ) : cyber.isError ? (
          <ErrorState onRetry={() => void cyber.refetch()} />
        ) : cyber.data.flags.length === 0 ? (
          <EmptyState icon="inbox" title="No flags" text={`${cyber.data.enabledSources} source(s) turned on. No message text is ever shown here.`} />
        ) : (
          <Table className="sr-table" rowKey={(r) => `${r.category}-${r.status}`} pagination={false} dataSource={cyber.data.flags} columns={[{ title: 'Category', dataIndex: 'category', key: 'c' }, { title: 'Status', dataIndex: 'status', key: 's' }, { title: 'Count', dataIndex: 'count', key: 'n' }]} />
        )}
      </SectionCard>
    </>
  );
}
