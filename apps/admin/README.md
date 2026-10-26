# apps/admin

React + TypeScript admin panel (Vite, Ant Design). Design: [`docs/design/admin-panel.html`](../../docs/design/admin-panel.html)
and [`docs/admin-design.md`](../../docs/admin-design.md). How to run: "Local setup" in the [main README](../../README.md).

| Path              | What it is                                             |
| ----------------- | ------------------------------------------------------ |
| `src/theme.ts`    | The one theme file (Ant Design tokens + extra colours) |
| `src/api.ts`      | Calls to the server (cookie session)                   |
| `src/auth/`       | Login, change password, 2-step setup and check         |
| `src/layout/`     | Sidebar, top bar, page head                            |
| `src/pages/`      | The 10 screens                                         |
| `src/components/` | Empty, loading, error and no-access states             |
| `e2e/`            | Playwright tests (test database only)                  |
