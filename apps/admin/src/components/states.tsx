import { Button, Card, Skeleton } from 'antd';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router';

// Icon outlines copied from the design page, so empty states match it exactly.
const ICONS = {
  inbox: (
    <>
      <path d="M3 13h5l1.5 2.5h5L16 13h5" />
      <path d="M5 5h14l2 8v6H3v-6z" />
    </>
  ),
  sos: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v6M12 16.5v.5" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6" />
    </>
  ),
  list: <path d="M8 6h13M8 12h13M8 18h13M3.5 6h.5M3.5 12h.5M3.5 18h.5" />,
  chart: <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />,
  lock: (
    <>
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </>
  ),
  wifi: <path d="M2 9a15 15 0 0 1 20 0M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0M12 19.5v.5" />,
};
export type IconName = keyof typeof ICONS;

/** Icon + bold line + one sentence (text from the design). */
export function EmptyState({ icon, title, text }: { icon: IconName; title: string; text: string }) {
  return (
    <div className="sr-empty">
      <div className="sr-empty-icon">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          {ICONS[icon]}
        </svg>
      </div>
      <b>{title}</b>
      <p>{text}</p>
    </div>
  );
}

/** Loading: placeholder lines in place of the content; title stays visible. */
export function LoadingState() {
  return (
    <Card>
      <Skeleton active paragraph={{ rows: 5 }} title={false} />
    </Card>
  );
}

/** Error: never raw server text. */
export function ErrorState({ onRetry }: { onRetry: () => void }) {
  return (
    <Card>
      <EmptyState
        icon="wifi"
        title="Couldn't load this page"
        text="Check your internet connection and try again. If it keeps happening, tell the TVL tech lead."
      />
      <div className="sr-center">
        <Button type="primary" onClick={onRetry}>
          Try again
        </Button>
      </div>
    </Card>
  );
}

/** A Support Admin opened a Super Admin page by URL (the server refuses the data too). */
export function NoAccessState() {
  const navigate = useNavigate();
  return (
    <Card>
      <EmptyState
        icon="lock"
        title="Only a Super Admin can open this page"
        text="Ask a Super Admin if you need a setting changed."
      />
      <div className="sr-center">
        <Button onClick={() => void navigate('/')}>Go to Dashboard</Button>
      </div>
    </Card>
  );
}

/** A card with a title, as in the design. */
export function SectionCard({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <Card className="sr-card">
      {title && <h2 className="sr-card-title">{title}</h2>}
      {children}
    </Card>
  );
}
