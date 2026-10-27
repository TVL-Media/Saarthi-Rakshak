import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Input, Modal, Select, Table, Tag } from 'antd';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { z } from 'zod';
import { api, ApiError, post, ROLE_LABEL, type Me } from '../api';
import { useAuthOptions, useMe } from '../auth/session';
import { ErrorState, LoadingState, SectionCard } from '../components/states';
import { formatTime } from '../format';

interface TeamMember {
  id: string;
  name: string;
  email: string;
  role: Me['role'];
  removed: boolean;
  last_login_at: string | null;
  twoStepEnabled: boolean;
}

const TEAM_KEY = ['admins'] as const;

/** The one-time password, shown once (never stored in the browser). */
interface IssuedPassword {
  name: string;
  temporaryPassword: string;
}

export function TeamBody() {
  const team = useQuery({ queryKey: TEAM_KEY, queryFn: () => api<TeamMember[]>('/admin/admins') });
  const me = useMe().data;
  const twoStep = useAuthOptions().data?.twoStep ?? true;
  const [adding, setAdding] = useState(false);
  const [issued, setIssued] = useState<IssuedPassword | null>(null);
  const [resetting, setResetting] = useState<TeamMember | null>(null);
  const [removing, setRemoving] = useState<TeamMember | null>(null);

  if (team.isPending) return <LoadingState />;
  if (team.isError) return <ErrorState onRetry={() => void team.refetch()} />;

  const columns = [
    {
      title: 'Name',
      key: 'name',
      render: (_: unknown, a: TeamMember) => (
        <span>
          {a.name} {a.id === me?.id && <Tag className="sr-tag">You</Tag>}
          {a.removed && <Tag className="sr-tag">Removed</Tag>}
        </span>
      ),
    },
    {
      title: 'Email',
      key: 'email',
      render: (_: unknown, a: TeamMember) => <span className="sr-mono">{a.email}</span>,
    },
    {
      title: 'Role',
      key: 'role',
      render: (_: unknown, a: TeamMember) => (
        <Tag className="sr-tag sr-tag-role">{ROLE_LABEL[a.role]}</Tag>
      ),
    },
    // Hidden while 2-step login is off (local development).
    ...(twoStep
      ? [
          {
            title: '2-step',
            key: 'twoStep',
            render: (_: unknown, a: TeamMember) =>
              a.twoStepEnabled ? (
                <span className="sr-badge ok">On</span>
              ) : (
                <span className="sr-badge off">Off</span>
              ),
          },
        ]
      : []),
    {
      title: 'Last login',
      key: 'last',
      render: (_: unknown, a: TeamMember) => (
        <span className="sr-mono">{formatTime(a.last_login_at)}</span>
      ),
    },
    {
      title: '',
      key: 'actions',
      render: (_: unknown, a: TeamMember) => {
        if (a.removed) return null;
        const self = a.id === me?.id;
        return (
          <span className="sr-row-actions">
            {a.role === 'support_admin' && (
              <Button type="link" className="sr-link-left" onClick={() => setResetting(a)}>
                Reset password
              </Button>
            )}
            <Button
              type="link"
              className="sr-link-left"
              disabled={self}
              onClick={() => setRemoving(a)}
            >
              Remove
            </Button>
          </span>
        );
      },
    },
  ];

  return (
    <>
      <SectionCard>
        <div className="sr-card-head">
          <h2 className="sr-card-title">Admins</h2>
          <Button type="primary" onClick={() => setAdding(true)}>
            Add admin
          </Button>
        </div>
        <Table
          className="sr-table"
          rowKey="id"
          columns={columns}
          dataSource={team.data}
          pagination={false}
          scroll={{ x: 'max-content' }}
          rowClassName={(a) => (a.removed ? 'sr-row-removed' : '')}
        />
      </SectionCard>

      {adding && (
        <AddAdminModal
          onClose={() => setAdding(false)}
          onAdded={(result) => {
            setAdding(false);
            setIssued(result);
          }}
        />
      )}
      {resetting && (
        <ResetPasswordModal
          member={resetting}
          onClose={() => setResetting(null)}
          onReset={(result) => {
            setResetting(null);
            setIssued(result);
          }}
        />
      )}
      {removing && <RemoveModal member={removing} onClose={() => setRemoving(null)} />}
      {issued && <PasswordModal issued={issued} onClose={() => setIssued(null)} />}
    </>
  );
}

const addSchema = z.object({
  name: z.string().trim().min(1, 'Enter a name'),
  email: z.email('Enter a valid email'),
  role: z.enum(['support_admin', 'super_admin']),
});
type AddForm = z.infer<typeof addSchema>;

function AddAdminModal(props: { onClose: () => void; onAdded: (issued: IssuedPassword) => void }) {
  const queryClient = useQueryClient();
  const [confirmSuper, setConfirmSuper] = useState(false);
  const { control, handleSubmit, formState, getValues } = useForm<AddForm>({
    resolver: zodResolver(addSchema),
    defaultValues: { name: '', email: '', role: 'support_admin' },
  });
  const add = useMutation({
    mutationFn: (form: AddForm) => post<{ temporaryPassword: string }>('/admin/admins', form),
    onSuccess: (result, form) => {
      void queryClient.invalidateQueries({ queryKey: TEAM_KEY });
      props.onAdded({ name: form.name.trim(), temporaryPassword: result.temporaryPassword });
    },
  });
  const serverError =
    add.error instanceof ApiError
      ? add.error.serverMessage
      : add.error
        ? "Couldn't add the admin. Check your internet connection and try again."
        : undefined;

  const submit = handleSubmit((form) => {
    // Adding a Super Admin needs one more confirmation.
    if (form.role === 'super_admin' && !confirmSuper) {
      setConfirmSuper(true);
      return;
    }
    add.mutate(form);
  });

  return (
    <>
      <Modal
        open={!confirmSuper}
        title="Add admin"
        onCancel={props.onClose}
        okText="Add admin"
        onOk={() => void submit()}
        confirmLoading={add.isPending}
      >
        <form className="sr-modal-body" onSubmit={(e) => void submit(e)} noValidate>
          {serverError && <Alert type="error" title={serverError} />}
          <div className="sr-field">
            <label htmlFor="a-name">Full name</label>
            <Controller
              name="name"
              control={control}
              render={({ field }) => (
                <Input
                  {...field}
                  id="a-name"
                  status={formState.errors.name ? 'error' : undefined}
                />
              )}
            />
            {formState.errors.name && (
              <span className="sr-err-text">{formState.errors.name.message}</span>
            )}
          </div>
          <div className="sr-field">
            <label htmlFor="a-email">Work email</label>
            <Controller
              name="email"
              control={control}
              render={({ field }) => (
                <Input
                  {...field}
                  id="a-email"
                  type="email"
                  status={formState.errors.email ? 'error' : undefined}
                />
              )}
            />
            {formState.errors.email && (
              <span className="sr-err-text">{formState.errors.email.message}</span>
            )}
          </div>
          <div className="sr-field">
            <label htmlFor="a-role">Role</label>
            <Controller
              name="role"
              control={control}
              render={({ field }) => (
                <Select
                  id="a-role"
                  value={field.value}
                  onChange={field.onChange}
                  options={[
                    { value: 'support_admin', label: 'Support Admin' },
                    { value: 'super_admin', label: 'Super Admin' },
                  ]}
                />
              )}
            />
            <small className="sr-hint">
              Support Admin cannot change settings, delete data, export audio or manage admins.
            </small>
          </div>
          <button type="submit" hidden />
        </form>
      </Modal>
      <Modal
        open={confirmSuper}
        title="Add as Super Admin?"
        okText="Add as Super Admin"
        onCancel={() => setConfirmSuper(false)}
        onOk={() => add.mutate(getValues())}
        confirmLoading={add.isPending}
      >
        <p className="sr-muted">
          Super Admins can change safety rules and manage admins. Add as Super Admin?
        </p>
        {serverError && <Alert type="error" title={serverError} />}
      </Modal>
    </>
  );
}

function ResetPasswordModal(props: {
  member: TeamMember;
  onClose: () => void;
  onReset: (issued: IssuedPassword) => void;
}) {
  const queryClient = useQueryClient();
  const reset = useMutation({
    mutationFn: () =>
      post<{ temporaryPassword: string }>(`/admin/admins/${props.member.id}/reset-password`),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: TEAM_KEY });
      props.onReset({ name: props.member.name, temporaryPassword: result.temporaryPassword });
    },
  });
  return (
    <Modal
      open
      title={`Reset password for ${props.member.name}?`}
      okText="Reset password"
      onCancel={props.onClose}
      onOk={() => reset.mutate()}
      confirmLoading={reset.isPending}
    >
      <p className="sr-muted">
        They are logged out, get a new temporary password and must set up their password and 2-step
        login again at their next login.
      </p>
      {reset.error && (
        <Alert
          type="error"
          title={
            reset.error instanceof ApiError
              ? reset.error.serverMessage
              : "Couldn't reset the password."
          }
        />
      )}
    </Modal>
  );
}

function RemoveModal(props: { member: TeamMember; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [reason, setReason] = useState('');
  const remove = useMutation({
    mutationFn: () => post(`/admin/admins/${props.member.id}/remove`, { reason }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: TEAM_KEY });
      props.onClose();
    },
  });
  const error =
    remove.error instanceof ApiError
      ? remove.error.serverMessage
      : remove.error
        ? "Couldn't remove the admin. Check your internet connection and try again."
        : undefined;
  return (
    <Modal
      open
      title={`Remove ${props.member.name}?`}
      okText="Remove"
      okButtonProps={{ danger: true, disabled: reason.trim().length === 0 }}
      onCancel={props.onClose}
      onOk={() => remove.mutate()}
      confirmLoading={remove.isPending}
    >
      <div className="sr-modal-body">
        <p className="sr-muted">They can no longer log in. Their history stays in the audit log.</p>
        <div className="sr-field">
          <label htmlFor="r-reason">Reason</label>
          <Input
            id="r-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            status={error ? 'error' : undefined}
          />
          {error ? (
            <span className="sr-err-text">{error}</span>
          ) : (
            <small className="sr-hint">Saved in the audit log.</small>
          )}
        </div>
      </div>
    </Modal>
  );
}

/** Shown once. The password lives only in this component's memory. */
function PasswordModal(props: { issued: IssuedPassword; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <Modal
      open
      title={`Temporary password for ${props.issued.name}`}
      onCancel={props.onClose}
      footer={[
        <Button key="done" type="primary" onClick={props.onClose}>
          Done
        </Button>,
      ]}
    >
      <div className="sr-modal-body">
        <div className="sr-key sr-password" data-testid="temporary-password">
          {props.issued.temporaryPassword}
        </div>
        <div>
          <Button
            onClick={() => {
              void navigator.clipboard.writeText(props.issued.temporaryPassword);
              setCopied(true);
            }}
          >
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
        <p className="sr-muted">
          Give this password to the person directly (in person or on a phone call). Don't send it by
          email or WhatsApp.
        </p>
        <p className="sr-hint">
          It is shown only now, works for 24 hours, and must be changed at the first login.
        </p>
      </div>
    </Modal>
  );
}
