import type { FormEventHandler, ReactNode } from 'react';
import { useAuthOptions } from './session';

export function Brand() {
  return (
    <div className="sr-brand">
      <b>SARTHI RAKSHAK</b>
      <span>Admin · Noida pilot</span>
    </div>
  );
}

/** The centred card used by every login screen. */
export function AuthCard({
  wide,
  onSubmit,
  children,
}: {
  wide?: boolean;
  onSubmit: FormEventHandler<HTMLFormElement>;
  children: ReactNode;
}) {
  return (
    <div className="sr-auth">
      <div className="sr-auth-wrap">
        <form
          className={wide ? 'sr-auth-card wide' : 'sr-auth-card'}
          onSubmit={onSubmit}
          noValidate
        >
          <Brand />
          {children}
        </form>
        <p className="sr-auth-foot">
          For authorised client staff only. Every view and action in this panel is recorded.
        </p>
      </div>
    </div>
  );
}

/** "1 · New password  2 · 2-step setup  3 · Backup codes" */
export function Steps({ current }: { current: 1 | 2 | 3 }) {
  const twoStep = useAuthOptions().data?.twoStep ?? true;
  // With 2-step login off (local development), setting the password is the only step.
  const labels = twoStep
    ? ['1 · New password', '2 · 2-step setup', '3 · Backup codes']
    : ['1 · New password'];
  return (
    <div className="sr-steps">
      {labels.map((label, i) => (
        <span key={label} className={i < current ? 'on' : undefined}>
          {label}
        </span>
      ))}
    </div>
  );
}

export function Heading({ title, text }: { title: string; text?: string }) {
  return (
    <div>
      <h1 className="sr-auth-title">{title}</h1>
      {text && <p className="sr-muted">{text}</p>}
    </div>
  );
}

/** A field with label, input and (optional) error or hint below. */
export function Field({
  id,
  label,
  error,
  children,
}: {
  id: string;
  label: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div className="sr-field">
      <label htmlFor={id}>{label}</label>
      {children}
      {error && (
        <span className="sr-err-text" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
