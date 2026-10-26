import { Avatar, Button, Drawer, Layout, Menu, Tag, type MenuProps } from 'antd';
import { useEffect, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { post, ROLE_LABEL, type Me } from '../api';
import { Brand } from '../auth/AuthCard';
import { useResetSession } from '../auth/session';
import { MAIN_SCREENS, SUPER_ADMIN_SCREENS } from '../pages/screens';

const NARROW = '(max-width: 860px)';

function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => window.matchMedia(NARROW).matches);
  useEffect(() => {
    const query = window.matchMedia(NARROW);
    const update = () => setNarrow(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return narrow;
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join('');
}

function SideMenu({ me, onNavigate }: { me: Me; onNavigate?: () => void }) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const items: MenuProps['items'] = [
    ...MAIN_SCREENS.map((s) => ({ key: s.path, label: s.menu })),
    // Hidden for Support Admins (the server refuses the data too).
    ...(me.role === 'super_admin'
      ? [
          {
            type: 'group' as const,
            label: 'SUPER ADMIN ONLY',
            children: SUPER_ADMIN_SCREENS.map((s) => ({ key: s.path, label: s.menu })),
          },
        ]
      : []),
  ];
  const selected = [...MAIN_SCREENS, ...SUPER_ADMIN_SCREENS]
    .filter((s) => (s.path === '/' ? pathname === '/' : pathname.startsWith(s.path)))
    .map((s) => s.path);

  return (
    <div className="sr-side">
      <div className="sr-side-brand">
        <Brand />
      </div>
      <Menu
        theme="dark"
        mode="inline"
        items={items}
        selectedKeys={selected}
        onClick={({ key }) => {
          onNavigate?.();
          void navigate(key);
        }}
      />
      <div className="sr-side-foot">Auto logout after 30 min without activity</div>
    </div>
  );
}

export function AppLayout({ me, children }: { me: Me; children: ReactNode }) {
  const narrow = useNarrow();
  const [menuOpen, setMenuOpen] = useState(false);
  const navigate = useNavigate();
  const resetSession = useResetSession();

  const logout = async () => {
    await post('/admin/auth/logout').catch(() => undefined);
    resetSession();
    void navigate('/login');
  };

  return (
    <Layout className="sr-shell">
      {!narrow && (
        <Layout.Sider width={232} className="sr-sider">
          <SideMenu me={me} />
        </Layout.Sider>
      )}
      {narrow && (
        <Drawer
          placement="left"
          open={menuOpen}
          onClose={() => setMenuOpen(false)}
          size={232}
          closable={false}
          styles={{ body: { padding: 0 } }}
        >
          <SideMenu me={me} onNavigate={() => setMenuOpen(false)} />
        </Drawer>
      )}
      <Layout>
        <Layout.Header className="sr-top">
          <div className="sr-top-left">
            {narrow && (
              <Button aria-label="Open menu" onClick={() => setMenuOpen(true)}>
                Menu
              </Button>
            )}
            <Tag className="sr-tag">Noida pilot</Tag>
          </div>
          <div className="sr-who">
            <Avatar className="sr-avatar" aria-hidden="true">
              {initials(me.name)}
            </Avatar>
            {!narrow && (
              <div className="sr-who-text">
                <b>{me.name}</b>
                <small>{ROLE_LABEL[me.role]}</small>
              </div>
            )}
            <Button onClick={() => void logout()}>Log out</Button>
          </div>
        </Layout.Header>
        <Layout.Content className="sr-content">{children}</Layout.Content>
      </Layout>
    </Layout>
  );
}

/** Title + one-line subtitle at the top of every screen. */
export function PageHead({ title, sub }: { title: string; sub?: string }) {
  return (
    <div className="sr-page-head">
      <h1>{title}</h1>
      {sub && <p>{sub}</p>}
    </div>
  );
}
