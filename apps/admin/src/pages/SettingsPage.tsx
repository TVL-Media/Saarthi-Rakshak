import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Input, Modal, Select, Space } from 'antd';
import { useMemo, useState } from 'react';
import { Controller, useForm, useWatch, type Resolver } from 'react-hook-form';
import { z } from 'zod';
import { api, ApiError } from '../api';
import { ErrorState, LoadingState, SectionCard } from '../components/states';

interface SettingView {
  key: string;
  value: number | null;
  min: number;
  max: number;
}
interface SettingsView {
  version: string;
  settings: SettingView[];
}

const GENERAL_RULE =
  'Applies to new SOS events and journeys from now on. Ones already running keep the old rule.';

/** Labels, units and hints from the design, in the design's order. */
const FIELDS: { key: string; label: string; unit: string; hint?: string; applies: string }[] = [
  {
    key: 'sos.countdown_seconds',
    label: 'SOS countdown',
    unit: 'sec',
    hint: 'Cancel without PIN',
    applies: GENERAL_RULE,
  },
  {
    key: 'checkin.stopped_minutes',
    label: 'Check-in: stopped too long',
    unit: 'min',
    applies: GENERAL_RULE,
  },
  {
    key: 'checkin.off_route_metres',
    label: 'Check-in: off route',
    unit: 'm',
    applies: GENERAL_RULE,
  },
  {
    key: 'checkin.late_minutes',
    label: 'Check-in: late arrival',
    unit: 'min',
    applies: GENERAL_RULE,
  },
  {
    key: 'checkin.reply_wait_minutes',
    label: 'Wait for check-in reply',
    unit: 'min',
    hint: 'Then alert guardians (not a full SOS)',
    applies: GENERAL_RULE,
  },
  {
    key: 'checkin.traffic_pause_minutes',
    label: '“Stuck in traffic” pause',
    unit: 'min',
    applies: GENERAL_RULE,
  },
  {
    key: 'journey.lost_contact_minutes',
    label: 'Lost contact (phone silent)',
    unit: 'min',
    applies: GENERAL_RULE,
  },
  {
    key: 'sos.no_response_minutes',
    label: 'No guardian responds to SOS',
    unit: 'min',
    hint: 'Re-send alerts and help the user call 112',
    applies: GENERAL_RULE,
  },
  {
    key: 'guardian.link_live_after_end_minutes',
    label: 'Guardian link after SOS ends',
    unit: 'min',
    applies: GENERAL_RULE,
  },
  {
    key: 'audio.auto_delete_days',
    label: 'Audio auto-delete',
    unit: 'days',
    hint: 'Unless the user keeps it',
    applies: 'Applies to new recordings only.',
  },
  {
    key: 'guardian.max_count',
    label: 'Max guardians',
    unit: 'people',
    applies: "Users who already have more keep them, but can't add more.",
  },
];

const SETTINGS_KEY = ['settings'] as const;

/** Form field name for a setting key: React Hook Form reads dots as nesting. */
const fieldName = (key: string) => key.replaceAll('.', '__');

function parseWholeNumber(text: string): number | null {
  const trimmed = text.trim();
  return /^\d+$/.test(trimmed) ? Number(trimmed) : null;
}

/**
 * A text box for whole numbers that reports every keystroke. Anything that is not a whole
 * number (empty, "4.5", "abc") becomes null, which the form shows as "Enter a whole number".
 */
function WholeNumberInput(props: {
  id: string;
  value: number | null;
  onChange: (value: number | null) => void;
  onBlur: () => void;
  invalid: boolean;
  describedBy: string;
}) {
  const [text, setText] = useState(props.value === null ? '' : String(props.value));
  // Follow a change from outside (Discard). While the box holds something that is not a number,
  // the form value is null, so what was typed stays visible.
  if (props.value !== null && parseWholeNumber(text) !== props.value) {
    setText(String(props.value));
  }
  return (
    <Input
      id={props.id}
      className="sr-mono"
      inputMode="numeric"
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        props.onChange(parseWholeNumber(e.target.value));
      }}
      onBlur={props.onBlur}
      status={props.invalid ? 'error' : undefined}
      aria-describedby={props.describedBy}
    />
  );
}

export function SettingsBody() {
  const query = useQuery({
    queryKey: SETTINGS_KEY,
    queryFn: () => api<SettingsView>('/admin/settings'),
  });
  if (query.isPending) return <LoadingState />;
  if (query.isError) return <ErrorState onRetry={() => void query.refetch()} />;
  // A new version (after a save or reload) starts a fresh form.
  return <SettingsForm key={query.data.version} view={query.data} />;
}

type Values = Record<string, number | null>;

function SettingsForm({ view }: { view: SettingsView }) {
  const queryClient = useQueryClient();
  const saved: Values = useMemo(
    () => Object.fromEntries(view.settings.map((s) => [fieldName(s.key), s.value])),
    [view],
  );
  const ranges = useMemo(() => new Map(view.settings.map((s) => [s.key, s])), [view]);
  const schema = useMemo(
    () =>
      z.object(
        Object.fromEntries(
          view.settings.map((s) => [
            fieldName(s.key),
            z
              .number({ error: 'Enter a whole number' })
              .int({ error: 'Enter a whole number' })
              .min(s.min, { error: `Must be ${s.min} or more` })
              .max(s.max, { error: `Must be ${s.max} or less` }),
          ]),
        ),
      ),
    [view],
  );

  const { control, reset, formState, getValues } = useForm<Values>({
    // An empty field is null in the form and fails the schema with "Enter a whole number".
    resolver: zodResolver(schema) as unknown as Resolver<Values>,
    mode: 'onChange',
    defaultValues: saved,
  });
  const values = useWatch({ control }) as Values;
  const changed = FIELDS.filter(
    (f) => ranges.has(f.key) && values[fieldName(f.key)] !== saved[fieldName(f.key)],
  );

  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState('');
  const save = useMutation({
    mutationFn: () =>
      api<{ changed: number; view: SettingsView }>('/admin/settings', {
        method: 'PATCH',
        body: {
          version: view.version,
          reason,
          values: Object.fromEntries(changed.map((f) => [f.key, getValues(fieldName(f.key))])),
        },
      }),
    onSuccess: (result) => {
      setConfirming(false);
      queryClient.setQueryData(SETTINGS_KEY, result.view);
    },
  });

  const saveError = save.error instanceof ApiError ? save.error : undefined;
  const changedElsewhere = saveError?.status === 409;
  const reasonError =
    saveError?.status === 400
      ? saveError.serverMessage
      : save.error && !saveError
        ? "Couldn't save. Check your internet connection and try again."
        : undefined;
  const n = changed.length;

  return (
    <>
      <SectionCard title="Safety rules">
        <div className="sr-set-grid">
          {FIELDS.filter((f) => ranges.has(f.key)).map((f) => (
            <div className="sr-field" key={f.key}>
              <label htmlFor={f.key}>{f.label}</label>
              <Controller
                name={fieldName(f.key)}
                control={control}
                render={({ field, fieldState }) => (
                  <>
                    <Space.Compact className="sr-unit">
                      <WholeNumberInput
                        id={f.key}
                        value={field.value}
                        onChange={field.onChange}
                        onBlur={field.onBlur}
                        invalid={Boolean(fieldState.error)}
                        describedBy={`${f.key}-hint`}
                      />
                      <span className="sr-unit-label">{f.unit}</span>
                    </Space.Compact>
                    {fieldState.error ? (
                      <span className="sr-err-text" role="alert">
                        {fieldState.error.message}
                      </span>
                    ) : (
                      f.hint && (
                        <small className="sr-hint" id={`${f.key}-hint`}>
                          {f.hint}
                        </small>
                      )
                    )}
                  </>
                )}
              />
            </div>
          ))}
        </div>
      </SectionCard>

      <SectionCard title="SMS providers">
        <div className="sr-set-grid">
          <div className="sr-field">
            <label htmlFor="s-main">Main provider</label>
            <Select
              id="s-main"
              disabled
              value="none"
              options={[{ value: 'none', label: 'Not set up' }]}
            />
            <small className="sr-hint">Keys are kept on the server, never shown here.</small>
          </div>
          <div className="sr-field">
            <label htmlFor="s-backup">Backup provider</label>
            <Select
              id="s-backup"
              disabled
              value="none"
              options={[{ value: 'none', label: 'Not set up' }]}
            />
          </div>
        </div>
      </SectionCard>

      <div className="sr-sticky-bar">
        <span className="sr-muted">
          {n === 0 ? 'No unsaved changes' : `${n} unsaved change${n === 1 ? '' : 's'}`}
        </span>
        <Space>
          <Button disabled={n === 0} onClick={() => reset(saved)}>
            Discard
          </Button>
          <Button
            type="primary"
            disabled={n === 0 || !formState.isValid}
            onClick={() => {
              save.reset();
              setReason('');
              setConfirming(true);
            }}
          >
            Save changes
          </Button>
        </Space>
      </div>

      <Modal
        open={confirming}
        title={`Save ${n} change${n === 1 ? '' : 's'}?`}
        onCancel={() => setConfirming(false)}
        destroyOnHidden
        footer={
          changedElsewhere
            ? [
                <Button
                  key="reload"
                  type="primary"
                  onClick={() => {
                    setConfirming(false);
                    void queryClient.invalidateQueries({ queryKey: SETTINGS_KEY });
                  }}
                >
                  Reload
                </Button>,
              ]
            : [
                <Button key="cancel" onClick={() => setConfirming(false)}>
                  Cancel
                </Button>,
                <Button
                  key="save"
                  type="primary"
                  loading={save.isPending}
                  disabled={reason.trim().length === 0}
                  onClick={() => save.mutate()}
                >
                  {n === 1 ? 'Save change' : 'Save changes'}
                </Button>,
              ]
        }
      >
        <div className="sr-modal-body">
          {changed.map((f) => (
            <p key={f.key} className="sr-muted">
              {f.label} · {saved[fieldName(f.key)] ?? '–'} {f.unit} → {values[fieldName(f.key)]}{' '}
              {f.unit}. {f.applies}
            </p>
          ))}
          {changedElsewhere && <Alert type="warning" title={saveError?.serverMessage} />}
          {!changedElsewhere && (
            <div className="sr-field">
              <label htmlFor="m-reason">Reason for the change</label>
              <Input
                id="m-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="e.g. Pilot users found 3 minutes too short"
                status={reasonError ? 'error' : undefined}
              />
              {reasonError ? (
                <span className="sr-err-text" role="alert">
                  {reasonError}
                </span>
              ) : (
                <small className="sr-hint">Saved in the audit log.</small>
              )}
            </div>
          )}
        </div>
      </Modal>
    </>
  );
}
