import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { Button, Input } from 'antd';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { useNavigate } from 'react-router';
import { z } from 'zod';
import { ApiError, post, STEP_ROUTE, type LoginStep } from '../api';
import { AuthCard, Field, Heading, Steps } from './AuthCard';
import { useResetSession } from './session';
import { StepGate } from './StepGate';

// Same minimum as the server (server/src/auth/password-rules.ts).
const MIN_LENGTH = 12;

const schema = z
  .object({ newPassword: z.string(), again: z.string() })
  .refine((f) => f.newPassword.length >= MIN_LENGTH, {
    path: ['newPassword'],
    message: `At least ${MIN_LENGTH} characters`,
  })
  .refine((f) => f.again === f.newPassword, {
    path: ['again'],
    message: "The two passwords don't match",
  });
type Form = z.infer<typeof schema>;

export function ChangePasswordPage() {
  return (
    <StepGate step="change_password">
      <ChangePasswordForm />
    </StepGate>
  );
}

function ChangePasswordForm() {
  const navigate = useNavigate();
  const resetSession = useResetSession();
  const { control, handleSubmit, formState } = useForm<Form>({
    resolver: zodResolver(schema),
    defaultValues: { newPassword: '', again: '' },
  });
  const typed = useWatch({ control, name: 'newPassword' });

  const save = useMutation({
    mutationFn: (form: Form) =>
      post<{ next: LoginStep | 'done' }>('/admin/auth/password', { newPassword: form.newPassword }),
    onSuccess: ({ next }) => {
      resetSession();
      void navigate(next === 'done' ? '/' : STEP_ROUTE[next]);
    },
    onError: (error) => {
      if (error instanceof ApiError && error.sessionReason) {
        resetSession();
        void navigate('/login', { state: { reason: 'ended' } });
      }
    },
  });

  // The server checks the last two rules; its message is shown under the field.
  const serverError =
    save.error instanceof ApiError && save.error.status === 400
      ? save.error.serverMessage
      : undefined;
  const otherError =
    save.error && !serverError && !(save.error instanceof ApiError && save.error.sessionReason);

  return (
    <AuthCard onSubmit={(e) => void handleSubmit((form) => save.mutate(form))(e)}>
      <Steps current={1} />
      <Heading
        title="Set your own password"
        text="You logged in with a temporary password. Choose a new one to continue."
      />
      <Field
        id="p-new"
        label="New password"
        error={
          serverError ??
          (otherError ? "Couldn't save. Check your internet connection and try again." : undefined)
        }
      >
        <Controller
          name="newPassword"
          control={control}
          render={({ field }) => (
            <Input.Password
              {...field}
              id="p-new"
              autoComplete="new-password"
              status={serverError || formState.errors.newPassword ? 'error' : undefined}
            />
          )}
        />
        <ul className="sr-rules">
          <li className={typed.length >= MIN_LENGTH ? 'met' : undefined}>At least 12 characters</li>
          <li>Not the same as the temporary password</li>
          <li>Does not contain the name part of your email</li>
        </ul>
      </Field>
      <Field id="p-again" label="Type it again" error={formState.errors.again?.message}>
        <Controller
          name="again"
          control={control}
          render={({ field }) => (
            <Input.Password
              {...field}
              id="p-again"
              autoComplete="new-password"
              status={formState.errors.again ? 'error' : undefined}
            />
          )}
        />
      </Field>
      <Button type="primary" htmlType="submit" block loading={save.isPending}>
        Save password
      </Button>
    </AuthCard>
  );
}
