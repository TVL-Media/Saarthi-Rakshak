import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { Alert, Button, Input } from 'antd';
import { Controller, useForm } from 'react-hook-form';
import { Navigate, useLocation, useNavigate } from 'react-router';
import { z } from 'zod';
import { ApiError, post, STEP_ROUTE, type LoginStep } from '../api';
import { AuthCard, Field, Heading } from './AuthCard';
import { LOGGED_OUT_MESSAGE, useMe, useResetSession, type LoginPageState } from './session';

const schema = z.object({
  email: z.string().trim().min(1, 'Enter your email'),
  password: z.string().min(1, 'Enter your password'),
});
type Form = z.infer<typeof schema>;

// Texts from the design. One reply for wrong details and a locked account (never says which).
const WRONG_DETAILS =
  'Email or password is wrong. After 5 wrong tries the account is locked for 15 minutes.';
const TOO_MANY_TRIES = 'Too many login tries from this network. Wait 15 minutes and try again.';
const NO_CONNECTION =
  'Check your internet connection and try again. If it keeps happening, tell the TVL tech lead.';

export function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const resetSession = useResetSession();
  const me = useMe();
  const loggedOutReason = (location.state as LoginPageState | null)?.reason;
  const loggedOutMessage = loggedOutReason ? LOGGED_OUT_MESSAGE[loggedOutReason] : undefined;

  const { control, handleSubmit, formState } = useForm<Form>({
    resolver: zodResolver(schema),
    defaultValues: { email: '', password: '' },
  });
  const login = useMutation({
    mutationFn: (form: Form) => post<{ next: LoginStep }>('/admin/auth/login', form),
    onSuccess: ({ next }) => {
      resetSession();
      void navigate(STEP_ROUTE[next]);
    },
  });

  if (me.isSuccess) return <Navigate to="/" replace />;

  const error = login.error;
  const wrongDetails = error instanceof ApiError && error.status === 401;
  const tooMany = error instanceof ApiError && error.status === 429;

  return (
    <AuthCard onSubmit={(e) => void handleSubmit((form) => login.mutate(form))(e)}>
      {loggedOutMessage && !error && <Alert type="info" title={loggedOutMessage} />}
      {loggedOutMessage && !error ? (
        <Heading title="Log in" />
      ) : (
        <Heading title="Log in" text="Use the email your Super Admin added you with." />
      )}
      {wrongDetails && <Alert type="error" role="alert" title={WRONG_DETAILS} />}
      {tooMany && <Alert type="warning" role="alert" title={TOO_MANY_TRIES} />}
      {error && !wrongDetails && !tooMany && (
        <Alert type="error" role="alert" title={NO_CONNECTION} />
      )}

      <Field id="l-email" label="Email" error={formState.errors.email?.message}>
        <Controller
          name="email"
          control={control}
          render={({ field }) => (
            <Input
              {...field}
              id="l-email"
              type="email"
              autoComplete="username"
              placeholder="name@company.in"
              status={wrongDetails || formState.errors.email ? 'error' : undefined}
            />
          )}
        />
      </Field>
      <Field id="l-pass" label="Password" error={formState.errors.password?.message}>
        <Controller
          name="password"
          control={control}
          render={({ field }) => (
            <Input.Password
              {...field}
              id="l-pass"
              autoComplete="current-password"
              status={wrongDetails || formState.errors.password ? 'error' : undefined}
            />
          )}
        />
      </Field>
      <Button type="primary" htmlType="submit" block loading={login.isPending}>
        Log in
      </Button>
      {!loggedOutMessage && (
        <p className="sr-small-text">Forgot your password? Ask a Super Admin to reset it.</p>
      )}
    </AuthCard>
  );
}
