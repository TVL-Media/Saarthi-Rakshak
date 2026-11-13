import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Input, Modal, Table, Tag, Tooltip } from 'antd';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { api, ApiError, post } from '../api';
import { useMe } from '../auth/session';
import { EmptyState, ErrorState, LoadingState, SectionCard } from '../components/states';
import { formatTime } from '../format';
import { PageHead } from '../layout/AppLayout';
import { UserPhase2Cards } from './Phase2Pages';

interface Profile {
  id: string;
  name: string | null;
  phone: string | null; // masked
  status: 'active' | 'blocked';
  createdAt: string;
  lastSeenAt: string | null;
  setup: {
    complete: boolean;
    permissions: Record<'location' | 'notifications' | 'sms' | 'microphone', boolean>;
    batteryOptimisationOff: boolean;
    guardianAccepted: boolean;
  };
  device: {
    model: string | null;
    androidVersion: string | null;
    appVersion: string | null;
    lastSeenAt: string | null;
  } | null;
  guardians: {
    id: string;
    name: string;
    phone: string | null;
    inviteStatus: 'pending' | 'accepted' | 'declined';
    lastAlertAt: string | null;
  }[];
  activity: {
    type: 'sos' | 'journey';
    id: string;
    startedAt: string;
    endedAt: string | null;
    status: string;
    isTest: boolean;
    trigger: string | null;
  }[];
}

const PERMISSION_LABEL: Record<keyof Profile['setup']['permissions'], string> = {
  location: 'Location permission',
  notifications: 'Notifications permission',
  sms: 'SMS permission',
  microphone: 'Microphone permission',
};

const INVITE: Record<
  Profile['guardians'][number]['inviteStatus'],
  { label: string; tone: string }
> = {
  accepted: { label: 'Accepted', tone: 'ok' },
  pending: { label: 'Pending', tone: 'warn' },
  declined: { label: 'Declined', tone: 'off' },
};

function Check({ ok, label }: { ok: boolean; label: string }) {
  return (
    <div className="sr-status-row">
      <span>{label}</span>
      {ok ? (
        <span className="sr-badge ok">Done</span>
      ) : (
        <span className="sr-badge warn">Not done</span>
      )}
    </div>
  );
}

export function UserProfileScreen() {
  const { id = '' } = useParams();
  const profile = useQuery({
    queryKey: ['user', id],
    queryFn: () => api<Profile>(`/admin/users/${id}`),
  });

  if (profile.isPending) {
    return (
      <>
        <PageHead title="User" />
        <LoadingState />
      </>
    );
  }
  if (profile.isError) {
    const notFound = profile.error instanceof ApiError && [400, 404].includes(profile.error.status);
    return (
      <>
        <PageHead title="User" />
        {notFound ? (
          <SectionCard>
            <EmptyState
              icon="user"
              title="User not found"
              text="Their data may have been deleted."
            />
          </SectionCard>
        ) : (
          <ErrorState onRetry={() => void profile.refetch()} />
        )}
      </>
    );
  }
  return <ProfileView profile={profile.data} />;
}

function ProfileView({ profile }: { profile: Profile }) {
  const me = useMe().data;
  const [blocking, setBlocking] = useState(false);
  const [deleting, setDeleting] = useState(false);

  return (
    <>
      <PageHead title={profile.name ?? 'User'} sub={profile.phone ?? undefined} />
      {profile.status === 'blocked' && (
        <Alert
          type="warning"
          title="This user is blocked: they cannot log in, start journeys or invite guardians. SOS always works."
        />
      )}

      <div className="sr-cols">
        <SectionCard title="Setup status">
          <div className="sr-status-list">
            {(Object.keys(PERMISSION_LABEL) as (keyof typeof PERMISSION_LABEL)[]).map((p) => (
              <Check key={p} ok={profile.setup.permissions[p]} label={PERMISSION_LABEL[p]} />
            ))}
            <Check
              ok={profile.setup.batteryOptimisationOff}
              label="Battery saving turned off for the app"
            />
            <Check ok={profile.setup.guardianAccepted} label="At least one guardian accepted" />
          </div>
        </SectionCard>
        <SectionCard title="Device">
          {profile.device ? (
            <div className="sr-status-list">
              <div className="sr-status-row">
                <span>Model</span>
                <span>{profile.device.model ?? '—'}</span>
              </div>
              <div className="sr-status-row">
                <span>Android</span>
                <span className="sr-mono">{profile.device.androidVersion ?? '—'}</span>
              </div>
              <div className="sr-status-row">
                <span>App version</span>
                <span className="sr-mono">{profile.device.appVersion ?? '—'}</span>
              </div>
              <div className="sr-status-row">
                <span>Last seen</span>
                <span className="sr-mono">{formatTime(profile.device.lastSeenAt)}</span>
              </div>
            </div>
          ) : (
            <EmptyState
              icon="user"
              title="No device yet"
              text="Device details appear after the user opens the app."
            />
          )}
        </SectionCard>
      </div>

      <SectionCard title="Guardians">
        <Table
          className="sr-table"
          rowKey="id"
          pagination={false}
          scroll={{ x: 'max-content' }}
          dataSource={profile.guardians}
          columns={[
            {
              title: 'Guardian',
              key: 'name',
              render: (_: unknown, g: Profile['guardians'][number]) => g.name,
            },
            {
              title: 'Phone',
              key: 'phone',
              render: (_: unknown, g: Profile['guardians'][number]) => (
                <span className="sr-mono">{g.phone ?? '—'}</span>
              ),
            },
            {
              title: 'Invite',
              key: 'invite',
              render: (_: unknown, g: Profile['guardians'][number]) => (
                <span className={`sr-badge ${INVITE[g.inviteStatus].tone}`}>
                  {INVITE[g.inviteStatus].label}
                </span>
              ),
            },
            {
              title: 'Last alert',
              key: 'alert',
              render: (_: unknown, g: Profile['guardians'][number]) => (
                <span className="sr-mono">{formatTime(g.lastAlertAt)}</span>
              ),
            },
          ]}
          locale={{
            emptyText: (
              <EmptyState
                icon="user"
                title="No guardians yet"
                text="Guardians the user invites appear here."
              />
            ),
          }}
        />
      </SectionCard>

      <SectionCard title="Recent activity">
        <Table
          className="sr-table"
          rowKey="id"
          pagination={false}
          scroll={{ x: 'max-content' }}
          dataSource={profile.activity}
          columns={[
            {
              title: 'Started',
              key: 'started',
              render: (_: unknown, a: Profile['activity'][number]) => (
                <span className="sr-mono">{formatTime(a.startedAt)}</span>
              ),
            },
            {
              title: 'Type',
              key: 'type',
              render: (_: unknown, a: Profile['activity'][number]) => (
                <span className="sr-tags">
                  {a.type === 'sos' ? 'SOS' : 'Journey'}
                  {a.isTest && <Tag className="sr-tag">TEST</Tag>}
                </span>
              ),
            },
            {
              title: 'Status',
              key: 'status',
              render: (_: unknown, a: Profile['activity'][number]) => a.status,
            },
            {
              title: 'Ended',
              key: 'ended',
              render: (_: unknown, a: Profile['activity'][number]) => (
                <span className="sr-mono">{formatTime(a.endedAt)}</span>
              ),
            },
          ]}
          locale={{
            emptyText: (
              <EmptyState
                icon="list"
                title="No activity yet"
                text="SOS events and journeys appear here."
              />
            ),
          }}
        />
      </SectionCard>

      <UserPhase2Cards userId={profile.id} />

      <SectionCard title="Actions">
        <div className="sr-row-actions sr-wrap">
          <Button onClick={() => setBlocking(true)}>
            {profile.status === 'blocked' ? 'Unblock' : 'Block'}
          </Button>
          <Tooltip title="Push notifications are not set up yet">
            <span>
              <Button disabled>Send setup reminder</Button>
            </span>
          </Tooltip>
          {me?.role === 'super_admin' && (
            <Button danger onClick={() => setDeleting(true)}>
              Delete data
            </Button>
          )}
        </div>
        <small className="sr-hint">
          Push notifications are not set up yet, so reminders cannot be sent.
        </small>
      </SectionCard>

      {blocking && <BlockModal profile={profile} onClose={() => setBlocking(false)} />}
      {deleting && <DeleteModal profile={profile} onClose={() => setDeleting(false)} />}
    </>
  );
}

function ReasonField(props: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  error?: string;
}) {
  return (
    <div className="sr-field">
      <label htmlFor={props.id}>Reason</label>
      <Input
        id={props.id}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        status={props.error ? 'error' : undefined}
      />
      {props.error ? (
        <span className="sr-err-text">{props.error}</span>
      ) : (
        <small className="sr-hint">Saved in the audit log.</small>
      )}
    </div>
  );
}

function errorText(error: unknown, fallback: string): string | undefined {
  if (!error) return undefined;
  return error instanceof ApiError ? (error.serverMessage ?? fallback) : fallback;
}

function BlockModal({ profile, onClose }: { profile: Profile; onClose: () => void }) {
  const queryClient = useQueryClient();
  const unblock = profile.status === 'blocked';
  const [reason, setReason] = useState('');
  const save = useMutation({
    mutationFn: () =>
      post(`/admin/users/${profile.id}/${unblock ? 'unblock' : 'block'}`, { reason }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['user', profile.id] });
      void queryClient.invalidateQueries({ queryKey: ['users'] });
      onClose();
    },
  });
  return (
    <Modal
      open
      title={unblock ? 'Unblock this user?' : 'Block this user?'}
      okText={unblock ? 'Unblock' : 'Block'}
      okButtonProps={{ disabled: reason.trim().length === 0 }}
      confirmLoading={save.isPending}
      onCancel={onClose}
      onOk={() => save.mutate()}
    >
      <div className="sr-modal-body">
        <p className="sr-muted">
          {unblock
            ? 'They can log in, start journeys and invite guardians again.'
            : "They can't log in, start new journeys or invite guardians. SOS always works, and an SOS or journey already running is not stopped."}
        </p>
        <ReasonField
          id="b-reason"
          value={reason}
          onChange={setReason}
          error={errorText(save.error, "Couldn't save. Try again.")}
        />
      </div>
    </Modal>
  );
}

function DeleteModal({ profile, onClose }: { profile: Profile; onClose: () => void }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [reason, setReason] = useState('');
  const remove = useMutation({
    mutationFn: () => post(`/admin/users/${profile.id}/delete-data`, { reason }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['users'] });
      queryClient.removeQueries({ queryKey: ['user', profile.id] });
      void navigate('/users');
    },
  });
  return (
    <Modal
      open
      title="Delete this user's data?"
      okText="Delete data"
      okButtonProps={{ danger: true, disabled: reason.trim().length === 0 }}
      confirmLoading={remove.isPending}
      onCancel={onClose}
      onOk={() => remove.mutate()}
    >
      <div className="sr-modal-body">
        <div>
          <b>Deleted for good:</b>
          <p className="sr-muted">Profile, guardians, journeys, locations, recordings.</p>
        </div>
        <div>
          <b>Kept:</b>
          <p className="sr-muted">SOS events and alerts, with no link to the person.</p>
        </div>
        <ReasonField
          id="d-reason"
          value={reason}
          onChange={setReason}
          error={errorText(remove.error, "Couldn't delete. Try again.")}
        />
      </div>
    </Modal>
  );
}
