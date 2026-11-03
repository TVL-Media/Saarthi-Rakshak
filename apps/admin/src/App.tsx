import { Navigate, Outlet, Route, Routes } from 'react-router';
import { ApiError, STEP_ROUTE } from './api';
import { ChangePasswordPage } from './auth/ChangePasswordPage';
import { LoginPage } from './auth/LoginPage';
import { useMe, type LoginPageState } from './auth/session';
import { TwoStepPage } from './auth/TwoStepPage';
import { TwoStepSetupPage } from './auth/TwoStepSetupPage';
import { ErrorState, LoadingState, NoAccessState } from './components/states';
import { AppLayout, PageHead } from './layout/AppLayout';
import { MAIN_SCREENS, SUPER_ADMIN_SCREENS, type Screen } from './pages/screens';
import { UserProfileScreen } from './pages/UserProfilePage';

/** Every panel page: needs a finished login. An ended session goes to /login with its reason. */
function RequireLogin() {
  const me = useMe();

  if (me.isPending) {
    return (
      <div className="sr-content">
        <LoadingState />
      </div>
    );
  }
  if (me.isError) {
    const error = me.error;
    if (error instanceof ApiError && error.status === 401) {
      if (error.sessionReason === 'login_incomplete' && error.body.next) {
        return <Navigate to={STEP_ROUTE[error.body.next]} replace />;
      }
      const reason = error.sessionReason === 'no_session' ? undefined : error.sessionReason;
      const state: LoginPageState = { reason };
      return <Navigate to="/login" replace state={state} />;
    }
    return (
      <div className="sr-content">
        <ErrorState onRetry={() => void me.refetch()} />
      </div>
    );
  }
  return (
    <AppLayout me={me.data}>
      <Outlet context={me.data} />
    </AppLayout>
  );
}

function ScreenPage({ screen }: { screen: Screen }) {
  const me = useMe();
  const blocked = screen.superOnly && me.data?.role !== 'super_admin';
  const Body = screen.body;
  return (
    <>
      <PageHead
        title={screen.title}
        sub={blocked ? undefined : screen.sub}
        note={blocked ? undefined : screen.note}
      />
      {blocked ? <NoAccessState /> : Body && <Body />}
    </>
  );
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/change-password" element={<ChangePasswordPage />} />
      <Route path="/two-step/setup" element={<TwoStepSetupPage />} />
      <Route path="/two-step" element={<TwoStepPage />} />
      <Route element={<RequireLogin />}>
        {[...MAIN_SCREENS, ...SUPER_ADMIN_SCREENS].map((screen) => (
          <Route key={screen.path} path={screen.path} element={<ScreenPage screen={screen} />} />
        ))}
        <Route path="/users/:id" element={<UserProfileScreen />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
