import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Input, Modal, Select, Space, Switch } from 'antd';
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
export const FIELDS: {
  key: string;
  label: string;
  unit: string;
  hint?: string;
  applies: string;
}[] = [
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
  // ---- Phase 2 ----
  {
    key: 'sos.photo_pairs_max',
    label: 'Photos per SOS',
    unit: 'pairs',
    hint: 'Front + back photo pairs while the SOS screen is open',
    applies: GENERAL_RULE,
  },
  {
    key: 'detection.shake_g_x10',
    label: 'Shake SOS strength',
    unit: '× 0.1 g',
    hint: '25 = 2.5 g for each of 3 shakes in 2 seconds',
    applies: 'Phase 2 · applies on each phone the next time the app opens.',
  },
  {
    key: 'detection.crash_g_x10',
    label: 'Crash detection impact',
    unit: '× 0.1 g',
    hint: 'Beta · with a speed drop from over 25 km/h',
    applies: 'Phase 2 · applies on each phone the next time the app opens.',
  },
  {
    key: 'detection.fall_g_x10',
    label: 'Fall detection impact',
    unit: '× 0.1 g',
    hint: 'Beta · after a free fall',
    applies: 'Phase 2 · applies on each phone the next time the app opens.',
  },
  {
    key: 'detection.countdown_seconds',
    label: 'Crash and fall countdown',
    unit: 'sec',
    hint: 'Loud countdown with "I\'m OK" before the SOS',
    applies: 'Phase 2 · applies on each phone the next time the app opens.',
  },
  {
    key: 'daily.battery_pause_pct',
    label: 'Full-day location pauses below',
    unit: '% battery',
    applies: 'Phase 2 · applies on each phone the next time the app opens.',
  },
  {
    key: 'evidence.delete_lock_days',
    label: 'Evidence deletion lock',
    unit: 'days',
    hint: 'Items cannot be deleted in the app before this; account deletion still works',
    applies: 'Applies to evidence added from now on.',
  },
  {
    key: 'community.reports_per_day',
    label: 'Community reports per user',
    unit: 'a day',
    applies: 'Applies from now on.',
  },
  {
    key: 'feature.shake',
    label: 'Shake SOS',
    unit: '1 on · 0 off',
    hint: 'Switch the feature off for everyone (staged release)',
    applies: 'Phase 2 · applies on each phone the next time the app opens.',
  },
  {
    key: 'feature.voice',
    label: 'Voice SOS',
    unit: '1 on · 0 off',
    hint: 'Switch the feature off for everyone (staged release)',
    applies: 'Phase 2 · applies on each phone the next time the app opens.',
  },
  {
    key: 'feature.photos',
    label: 'Photos at SOS start',
    unit: '1 on · 0 off',
    hint: 'Switch the feature off for everyone (staged release)',
    applies: 'Phase 2 · applies on each phone the next time the app opens.',
  },
  {
    key: 'feature.crash',
    label: 'Crash detection',
    unit: '1 on · 0 off',
    hint: 'Switch the feature off for everyone (staged release)',
    applies: 'Phase 2 · applies on each phone the next time the app opens.',
  },
  {
    key: 'feature.fall',
    label: 'Fall detection',
    unit: '1 on · 0 off',
    hint: 'Switch the feature off for everyone (staged release)',
    applies: 'Phase 2 · applies on each phone the next time the app opens.',
  },
  {
    key: 'feature.daily_location',
    label: 'Full-day location',
    unit: '1 on · 0 off',
    hint: 'Switch the feature off for everyone (staged release)',
    applies: 'Phase 2 · applies on each phone the next time the app opens.',
  },
  {
    key: 'feature.vault',
    label: 'Evidence vault',
    unit: '1 on · 0 off',
    hint: 'Switch the feature off for everyone (staged release)',
    applies: 'Phase 2 · applies on each phone the next time the app opens.',
  },
  {
    key: 'feature.community',
    label: 'Community feed',
    unit: '1 on · 0 off',
    hint: 'Switch the feature off for everyone (staged release)',
    applies: 'Phase 2 · applies on each phone the next time the app opens.',
  },
  {
    key: 'feature.rakshak',
    label: 'Rakshak sign-up',
    unit: '1 on · 0 off',
    hint: 'Switch the feature off for everyone (staged release)',
    applies: 'Phase 2 · applies on each phone the next time the app opens.',
  },
  {
    key: 'feature.plans',
    label: 'Plans and payments',
    unit: '1 on · 0 off',
    hint: 'Switch the feature off for everyone (staged release)',
    applies: 'Phase 2 · applies on each phone the next time the app opens.',
  },
  {
    key: 'feature.nearby',
    label: 'Rakshaks Near Me',
    unit: '1 on · 0 off',
    hint: 'Approved Rakshaks appear while they switch "Available now" on in the app. Switch on to show it',
    applies: 'Phase 3 · applies on each phone the next time the app opens.',
  },
  {
    key: 'rakshak.available_hours',
    label: 'Rakshak "Available now" turns off after',
    unit: 'hours',
    hint: 'The Rakshak can switch it on again; it stops sharing their location until then',
    applies: 'Phase 3 · applies the next time a Rakshak switches it on.',
  },
  {
    key: 'feature.bookings',
    label: 'Book a Rakshak and My Bookings',
    unit: '1 on · 0 off',
    hint: 'Switch on to show booking in the app. Bookings then appear under Bookings',
    applies: 'Phase 3 · applies on each phone the next time the app opens.',
  },
  {
    key: 'feature.night_mode',
    label: 'Night Mode and Essential Safety Tools',
    unit: '1 on · 0 off',
    hint: 'Switch on to show Night Mode in the app',
    applies: 'Phase 4 · applies on each phone the next time the app opens.',
  },
  {
    key: 'feature.safe_places',
    label: 'Nearby Safe Place Finder',
    unit: '1 on · 0 off',
    hint: 'Needs a Google Places key on the server for map places; partner points work without it',
    applies: 'Phase 4 · applies on each phone the next time the app opens.',
  },
  {
    key: 'feature.women_safety',
    label: 'Women Safety',
    unit: '1 on · 0 off',
    hint: 'Home, harassment reports, support network and guidance',
    applies: 'Phase 4 · applies on each phone the next time the app opens.',
  },
  {
    key: 'feature.legal_support',
    label: 'Men’s Safety and Legal Support',
    unit: '1 on · 0 off',
    hint: 'Workplace and disputed-allegation reports, lawyer directory and requests',
    applies: 'Phase 4 · applies on each phone the next time the app opens.',
  },
  {
    key: 'feature.child_safety',
    label: 'Child Safety',
    unit: '1 on · 0 off',
    hint: 'Family link, zones and route alerts',
    applies: 'Phase 4 · applies on each phone the next time the app opens.',
  },
  {
    key: 'feature.chhupa_rakshak',
    label: 'Chhupa Rakshak',
    unit: '1 on · 0 off',
    hint: 'Consent-based, visible location checks by a parent',
    applies: 'Phase 4 · applies on each phone the next time the app opens.',
  },
  {
    key: 'feature.school',
    label: 'School Monitoring',
    unit: '1 on · 0 off',
    hint: 'Attendance and arrival events the school sends',
    applies: 'Phase 4 · applies on each phone the next time the app opens.',
  },
  {
    key: 'feature.cyber_safety',
    label: 'Cyberbullying check',
    unit: '1 on · 0 off',
    hint: 'Checks only text the family chooses to share',
    applies: 'Phase 4 · applies on each phone the next time the app opens.',
  },
  {
    key: 'feature.smart_glasses',
    label: 'Smart Glasses',
    unit: '1 on · 0 off',
    hint: 'Supported-model list and pairing check',
    applies: 'Phase 4 · applies on each phone the next time the app opens.',
  },
  {
    key: 'feature.safe_route',
    label: 'Safer route',
    unit: '1 on · 0 off',
    hint: 'Compares routes using imported safety data',
    applies: 'Phase 4 · applies on each phone the next time the app opens.',
  },
  {
    key: 'feature.police_handoff',
    label: 'Police / ERSS handoff',
    unit: '1 on · 0 off',
    hint: 'Sends SOS to an approved authority endpoint and shows its real status',
    applies: 'Phase 4 · applies on each phone the next time the app opens.',
  },
  {
    key: 'monitor.expiry_minutes',
    label: 'Chhupa Rakshak: session length',
    unit: 'min',
    hint: 'A session stops by itself after this long',
    applies: 'Phase 4 · applies at once.',
  },
  {
    key: 'monitor.retention_days',
    label: 'Chhupa Rakshak: location kept for',
    unit: 'days',
    hint: 'Older session locations are deleted',
    applies: 'Phase 4 · applies at once.',
  },
  {
    key: 'school.stale_feed_hours',
    label: 'School: warn if nothing received for',
    unit: 'hours',
    hint: 'Parents see that the feed may be out of date',
    applies: 'Phase 4 · applies at once.',
  },
  {
    key: 'safe_places.cache_minutes',
    label: 'Map places kept for',
    unit: 'min',
    hint: 'How long a nearby-places search is kept before asking the map provider again',
    applies: 'Phase 4 · applies at once.',
  },
  {
    key: 'child.max_accuracy_m',
    label: 'Child location: roughest accuracy for an alert',
    unit: 'm',
    hint: 'A less accurate location never raises a definite zone or route alert',
    applies: 'Phase 4 · applies at once.',
  },
  {
    key: 'child.deviation_m',
    label: 'Child route: off-route distance',
    unit: 'm',
    applies: 'Phase 4 · applies at once.',
  },
  {
    key: 'child.deviation_seconds',
    label: 'Child route: off-route time before an alert',
    unit: 'sec',
    applies: 'Phase 4 · applies at once.',
  },
  {
    key: 'child.stale_gps_minutes',
    label: 'Child location: stale after',
    unit: 'min',
    hint: 'The parent sees a stale-GPS warning after this long',
    applies: 'Phase 4 · applies at once.',
  },
];

const SETTINGS_KEY = ['settings'] as const;

const isSwitch = (key: string) => key.startsWith('feature.');
const isTuning = (key: string) => /^(child|monitor|school|safe_places)\./.test(key);
const GROUPS: { title: string; note?: string; test: (key: string) => boolean }[] = [
  { title: 'Safety rules', test: (k) => !isSwitch(k) && !isTuning(k) },
  {
    title: 'Feature switches',
    note: 'Turn a feature on or off for every phone. Phones pick the change up the next time the app opens.',
    test: isSwitch,
  },
  { title: 'Child safety, school and map tuning', test: isTuning },
];

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
  const problems = Object.keys(formState.errors).length;
  const goToProblem = () => {
    const first = Object.keys(formState.errors)[0];
    if (!first) return;
    const el = document.querySelector<HTMLElement>(`[data-setting="${first.replaceAll('__', '.')}"]`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el?.querySelector<HTMLElement>('input')?.focus({ preventScroll: true });
  };

  return (
    <>
      {GROUPS.map((group) => {
        const fields = FIELDS.filter((f) => ranges.has(f.key) && group.test(f.key));
        if (fields.length === 0) return null;
        return (
          <SectionCard title={group.title} key={group.title}>
            {group.note && <p className="sr-muted sr-group-note">{group.note}</p>}
            <div className="sr-set-grid">
              {fields.map((f) => (
                <div className="sr-field" key={f.key} data-setting={f.key}>
                  <label htmlFor={f.key}>{f.label}</label>
                  <Controller
                    name={fieldName(f.key)}
                    control={control}
                    render={({ field, fieldState }) => (
                      <>
                        {isSwitch(f.key) ? (
                          <div className="sr-switch-row">
                            <Switch
                              id={f.key}
                              checked={field.value === 1}
                              onChange={(on) => field.onChange(on ? 1 : 0)}
                              aria-describedby={`${f.key}-hint`}
                            />
                            <span>{field.value === 1 ? 'On' : 'Off'}</span>
                          </div>
                        ) : (
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
                        )}
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
        );
      })}

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
          {problems > 0 && (
            <>
              {' · '}
              <span className="sr-err-text" role="alert">
                {problems} value{problems === 1 ? ' needs' : 's need'} fixing before you can save
              </span>{' '}
              <Button type="link" size="small" onClick={goToProblem}>
                Show me
              </Button>
            </>
          )}
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
