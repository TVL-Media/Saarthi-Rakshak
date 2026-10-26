import { useMutation } from '@tanstack/react-query';
import { Button, Input } from 'antd';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { ApiError, post } from '../api';
import { AuthCard, Field, Heading } from './AuthCard';
import { useResetSession } from './session';
import { StepGate } from './StepGate';

/** Passed to the Dashboard in router state after a backup code was used (memory only). */
export interface DashboardState {
  backupCodesLeft?: number;
}

export function TwoStepPage() {
  return (
    <StepGate step="verify_2fa">
      <TwoStepForm />
    </StepGate>
  );
}

function TwoStepForm() {
  const navigate = useNavigate();
  const resetSession = useResetSession();
  const [useBackup, setUseBackup] = useState(false);
  const [code, setCode] = useState('');
  const [backupCode, setBackupCode] = useState('');

  const verify = useMutation({
    mutationFn: () =>
      post<{ backupCodesLeft: number }>(
        '/admin/auth/2fa/verify',
        useBackup ? { backupCode: backupCode.trim() } : { code },
      ),
    onSuccess: ({ backupCodesLeft }) => {
      resetSession();
      const state: DashboardState = useBackup ? { backupCodesLeft } : {};
      void navigate('/', { state });
    },
    onError: (error) => {
      if (error instanceof ApiError && error.sessionReason) {
        resetSession();
        void navigate('/login', { state: { reason: 'ended' } });
      }
    },
  });
  const backToLogin = async () => {
    await post('/admin/auth/logout').catch(() => undefined);
    resetSession();
    void navigate('/login');
  };

  const error = verify.error;
  const message =
    error instanceof ApiError && error.status === 401 && !error.sessionReason
      ? "That code didn't work. Try the newest code in the app."
      : error instanceof ApiError && error.status === 429
        ? 'Too many login tries from this network. Wait 15 minutes and try again.'
        : error && !(error instanceof ApiError && error.sessionReason)
          ? "Couldn't check the code. Check your internet connection and try again."
          : undefined;
  const ready = useBackup ? backupCode.trim().length > 0 : code.length === 6;

  return (
    <AuthCard
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) verify.mutate();
      }}
    >
      <Heading
        title="Enter your 2-step code"
        text="Open your authenticator app and enter the 6-digit code for Sarthi Rakshak."
      />
      {useBackup ? (
        <Field id="v-backup" label="Backup code" error={message}>
          <Input
            id="v-backup"
            className="sr-mono"
            autoComplete="one-time-code"
            placeholder="XXXXX-XXXXX-XXXX"
            value={backupCode}
            onChange={(e) => setBackupCode(e.target.value)}
            status={message ? 'error' : undefined}
          />
        </Field>
      ) : (
        <Field id="v-code" label="Code" error={message}>
          <Input.OTP
            id="v-code"
            length={6}
            className="sr-otp"
            value={code}
            onChange={setCode}
            formatter={(v) => v.replace(/\D/g, '')}
            status={message ? 'error' : undefined}
          />
        </Field>
      )}
      <Button type="primary" htmlType="submit" block loading={verify.isPending}>
        Verify
      </Button>
      <div className="sr-row-between">
        <Button
          type="link"
          className="sr-link-left"
          onClick={() => {
            verify.reset();
            setUseBackup(!useBackup);
          }}
        >
          {useBackup ? 'Use the authenticator app' : 'Use a backup code'}
        </Button>
        <Button type="link" className="sr-link-left" onClick={() => void backToLogin()}>
          Back to log in
        </Button>
      </div>
    </AuthCard>
  );
}
