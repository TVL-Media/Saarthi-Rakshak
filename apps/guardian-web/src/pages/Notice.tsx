import type { ReactNode } from 'react';
import { Footer } from './Footer';

/** A simple full-page message (link not found, alert ended, error). */
export function Notice({
  title,
  children,
  tone = 'plain',
}: {
  title: string;
  children?: ReactNode;
  tone?: 'plain' | 'ok' | 'warn';
}) {
  return (
    <main className="page">
      <Brand />
      <section className={`card notice notice-${tone}`} role="status">
        <h1>{title}</h1>
        {children && <p>{children}</p>}
      </section>
      <Footer />
    </main>
  );
}

export function Brand() {
  return (
    <header className="brand">
      <span className="brand-mark" aria-hidden="true">
        SR
      </span>
      <span className="brand-name">Sarthi Rakshak</span>
    </header>
  );
}
