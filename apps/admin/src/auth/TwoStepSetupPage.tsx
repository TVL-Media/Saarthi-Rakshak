import { useMutation, useQuery } from '@tanstack/react-query';
import { Alert, Button, Checkbox, Input, QRCode, Skeleton } from 'antd';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { ApiError, post } from '../api';
import { AuthCard, Field, Heading, Steps } from './AuthCard';
import { useResetSession } from './session';
import { StepGate } from './StepGate';

const WRONG_CODE = "That code didn't work. Check the time on your phone and try the newest code.";

export function TwoStepSetupPage() {
  // Backup codes live only in this component's memory: shown once, never stored.
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null);
  return (
    <StepGate step="setup_2fa" hold={backupCodes !== null}>
      {backupCodes ? <BackupCodes codes={backupCodes} /> : <Setup onDone={setBackupCodes} />}
    </StepGate>
  );
}

function Setup({ onDone }: { onDone: (codes: string[]) => void }) {
  const navigate = useNavigate();
  const resetSession = useResetSession();
  const [code, setCode] = useState('');

  // Asked once per visit: a second request would replace the secret behind the QR code.
  const setup = useQuery({
    queryKey: ['two-step-setup'],
    queryFn: () => post<{ otpauthUrl: string; secret: string }>('/admin/auth/2fa/setup'),
    retry: false,
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });
  const confirm = useMutation({
    mutationFn: () => post<{ backupCodes: string[] }>('/admin/auth/2fa/setup/confirm', { code }),
    onSuccess: ({ backupCodes }) => onDone(backupCodes),
    onError: (error) => {
      if (error instanceof ApiError && error.sessionReason) {
        resetSession();
        void navigate('/login', { state: { reason: 'ended' } });
      }
    },
  });

  const error = confirm.error;
  const codeError =
    error instanceof ApiError && error.status === 401 && !error.sessionReason
      ? WRONG_CODE
      : error instanceof ApiError && error.status === 429
        ? 'Too many login tries from this network. Wait 15 minutes and try again.'
        : error && !(error instanceof ApiError && error.sessionReason)
          ? "Couldn't check the code. Check your internet connection and try again."
          : undefined;

  return (
    <AuthCard
      wide
      onSubmit={(e) => {
        e.preventDefault();
        if (code.length === 6) confirm.mutate();
      }}
    >
      <Steps current={2} />
      <Heading
        title="Turn on 2-step login"
        text="Each time you log in you'll also enter a code from an authenticator app on your phone, such as Google Authenticator or Microsoft Authenticator."
      />
      {setup.isPending && <Skeleton active />}
      {setup.isError && (
        <Alert
          type="error"
          title="Couldn't load the QR code. Check your internet connection and try again."
          action={
            <Button size="small" onClick={() => void setup.refetch()}>
              Try again
            </Button>
          }
        />
      )}
      {setup.data && (
        <div className="sr-qr-row">
          <QRCode
            value={setup.data.otpauthUrl}
            size={160}
            bordered
            aria-label="QR code from the server"
          />
          <div className="sr-qr-side">
            <b>1. Scan this QR code</b>
            <p className="sr-small-text">
              Open your authenticator app, tap “Add”, and scan. Can't scan? Type this key instead:
            </p>
            <div className="sr-key" data-testid="setup-key">
              {setup.data.secret}
            </div>
            <Button
              type="link"
              className="sr-link-left"
              onClick={() => void navigator.clipboard.writeText(setup.data.secret)}
            >
              Copy key
            </Button>
          </div>
        </div>
      )}
      <Field id="s-code" label="2. Enter the 6-digit code from the app" error={codeError}>
        <Input.OTP
          id="s-code"
          length={6}
          className="sr-otp"
          value={code}
          onChange={setCode}
          formatter={(v) => v.replace(/\D/g, '')}
          status={codeError ? 'error' : undefined}
        />
      </Field>
      <Button
        type="primary"
        htmlType="submit"
        block
        disabled={!setup.data}
        loading={confirm.isPending}
      >
        Turn on 2-step login
      </Button>
    </AuthCard>
  );
}

function BackupCodes({ codes }: { codes: string[] }) {
  const navigate = useNavigate();
  const resetSession = useResetSession();
  const [saved, setSaved] = useState(false);
  return (
    <AuthCard
      wide
      onSubmit={(e) => {
        e.preventDefault();
        if (!saved) return;
        resetSession();
        void navigate('/');
      }}
    >
      <Steps current={3} />
      <Heading
        title="Save your backup codes"
        text="If you lose your phone, each code lets you log in once. You will not see these codes again."
      />
      <Alert type="success" title="2-step login is on." />
      <div className="sr-codes" aria-label="10 backup codes" data-testid="backup-codes">
        {codes.map((c) => (
          <span key={c}>{c}</span>
        ))}
      </div>
      <div>
        <Button onClick={() => void navigator.clipboard.writeText(codes.join('\n'))}>
          Copy all codes
        </Button>
      </div>
      <Checkbox checked={saved} onChange={(e) => setSaved(e.target.checked)}>
        I have saved these codes somewhere safe, away from this computer.
      </Checkbox>
      <Button type="primary" htmlType="submit" block disabled={!saved}>
        Continue to the panel
      </Button>
    </AuthCard>
  );
}
