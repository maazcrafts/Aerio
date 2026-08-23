import React, { useState, useEffect, Suspense, lazy } from 'react';
import axios from 'axios';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
const LandingPage = lazy(() => import('./components/LandingPage'));
const AuthPage = lazy(() => import('./components/AuthPage'));
const SignupPage = lazy(() => import('./components/SignupPage'));
const ChatDashboard = lazy(() => import('./components/ChatDashboard'));
const AdminDashboard = lazy(() => import('./components/AdminDashboard'));
const MaintenancePage = lazy(() => import('./components/MaintenancePage'));
import { API_BASE_URL, API_URL } from './config';
import { applyAppearance, DEFAULT_USER_SETTINGS, applyLocalAppearance, getLocalSettings } from './utils/appearance';
import { SessionExpiredState, OfflineBanner } from './components/UIStates';
import { useNetworkStatus } from './hooks/useNetworkStatus';

const KEEP_ALIVE_URL = `${API_BASE_URL}/health`;
const KEEP_ALIVE_INTERVAL_MS = 10 * 60 * 1000;

// ROOT CAUSE FIX: previously the Authorization header was only ever set
// inside a useEffect (keyed on `user`) here in App. React runs a mounting
// child component's own effects (e.g. ChatDashboard's initial
// fetchContacts() call) BEFORE this parent effect in the same commit, so on
// the very first render after login — and sometimes after a refresh — the
// child's request could fire before axios.defaults.headers had the token,
// producing an intermittent 401 on endpoints like GET /api/contacts/:id.
//
// A request interceptor removes that timing dependency entirely: it reads
// the token straight from localStorage synchronously for every single
// outgoing request, so the header is always attached no matter which
// component fires the request or when it mounts.
axios.interceptors.request.use((config) => {
  try {
    const savedUser = localStorage.getItem('chat_user');
    const token = savedUser ? JSON.parse(savedUser)?.token : null;
    if (token) {
      config.headers = config.headers || {};
      config.headers.Authorization = `Bearer ${token}`;
    }
  } catch (_) { }
  return config;
});

function App() {
  const [user, setUser] = useState(null);
  const [authReady, setAuthReady] = useState(false);
  const [publicSettings, setPublicSettings] = useState(null);
  const [userSettings, setUserSettings] = useState(DEFAULT_USER_SETTINGS);
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [sessionExpired, setSessionExpired] = useState(false);
  const isOnline = useNetworkStatus();

  useEffect(() => {
    const savedUser = localStorage.getItem('chat_user');
    if (savedUser) {
      try {
        const parsed = JSON.parse(savedUser);
        if (parsed?.token) {
          axios.defaults.headers.common['Authorization'] = `Bearer ${parsed.token}`;
          setUser(parsed);
        } else {
          localStorage.removeItem('chat_user');
        }
      } catch (e) {
        localStorage.removeItem('chat_user');
      }
    }
    setAuthReady(true);
  }, []);

  useEffect(() => {
    if (user?.token) {
      axios.defaults.headers.common['Authorization'] = `Bearer ${user.token}`;
    } else {
      delete axios.defaults.headers.common['Authorization'];
    }
  }, [user]);

  useEffect(() => {
    let cancelled = false;

    const loadUserSettings = async () => {
      if (!user?.token) {
        setUserSettings(DEFAULT_USER_SETTINGS);
        applyAppearance(DEFAULT_USER_SETTINGS);
        applyLocalAppearance();
        return;
      }

      applyLocalAppearance(getLocalSettings(user.id));
      setSettingsLoading(true);
      try {
        const { data } = await axios.get(`${API_URL}/settings/user`);
        if (!cancelled) {
          const settings = { ...DEFAULT_USER_SETTINGS, ...data };
          setUserSettings(settings);
          applyAppearance(settings);
        }
      } catch (_) {
        // Keep the UI usable if the network is temporarily unavailable, but never
        // use another user's cached settings.
        try {
          const cached = JSON.parse(localStorage.getItem(`chat_user_settings_${user.id}`) || 'null');
          if (!cancelled && cached) {
            const settings = { ...DEFAULT_USER_SETTINGS, ...cached };
            setUserSettings(settings);
            applyAppearance(settings);
          }
        } catch (_) { }
      } finally {
        if (!cancelled) setSettingsLoading(false);
      }
    };

    loadUserSettings();
    return () => { cancelled = true; };
  }, [user?.id, user?.token]);

  useEffect(() => {
    const interceptor = axios.interceptors.response.use(
      (res) => res,
      (error) => {
        const status = error?.response?.status;
        const url = String(error?.config?.url || '');
        const isAuthRoute = url.includes('/api/auth/');
        if ((status === 401 || status === 403) && user?.token && !isAuthRoute) {
          // Invalid/expired session — show the Session Expired screen and stop
          // sending the stale token, but keep the cached user/localStorage
          // around until the person explicitly taps "Log In Again" so we
          // don't lose context mid-request and so this fires once, not per
          // failed request.
          if (status === 401 || (status === 403 && error?.response?.data?.error === 'Invalid or expired token')) {
            delete axios.defaults.headers.common['Authorization'];
            setSessionExpired(true);
          }
        }
        return Promise.reject(error);
      }
    );
    return () => axios.interceptors.response.eject(interceptor);
  }, [user]);

  useEffect(() => {
    const load = async () => {
      try {
        const res = await axios.get(`${API_URL}/settings/public`);
        setPublicSettings(res.data);
      } catch (_) { }
    };
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    let timer;
    const ping = () => {
      try {
        fetch(KEEP_ALIVE_URL, { mode: 'no-cors', cache: 'no-store' }).catch(() => { });
      } catch (_) { }
    };

    ping();
    timer = setInterval(ping, KEEP_ALIVE_INTERVAL_MS);
    return () => clearInterval(timer);
  }, []);

  const isAdmin = user?.username === 'maaz_khan' || user?.role === 'admin';
  const maintenanceMode = !!publicSettings?.maintenance_mode;

  const handleLoginAgain = () => {
    localStorage.removeItem('chat_user');
    delete axios.defaults.headers.common['Authorization'];
    setSessionExpired(false);
    setUser(null);
  };

  if (!authReady) {
    return <div className="app-container" />;
  }

  if (sessionExpired) {
    return <SessionExpiredState onLoginAgain={handleLoginAgain} />;
  }

  return (
    <Router>
      <OfflineBanner visible={!isOnline} />
      <Suspense fallback={<div className="app-container" />}>
        <Routes>
          <Route
            path="/"
            element={
              maintenanceMode && !isAdmin
                ? <MaintenancePage message={publicSettings?.welcome_message} />
                : (user ? <Navigate to="/chat" /> : <LandingPage />)
            }
          />


          <Route
            path="/auth"
            element={
              maintenanceMode && !isAdmin
                ? <MaintenancePage message={publicSettings?.welcome_message} />
                : (user ? <Navigate to="/chat" /> : <AuthPage setUser={setUser} publicSettings={publicSettings} />)
            }
          />

          <Route
            path="/chat"
            element={
              maintenanceMode && !isAdmin
                ? <MaintenancePage message={publicSettings?.welcome_message} />
                : (user ? <ChatDashboard user={user} setUser={setUser} userSettings={userSettings} settingsLoading={settingsLoading} onSettingsSaved={setUserSettings} /> : <Navigate to="/auth" />)
            }
          />

          <Route path="/signup" element={user ? <Navigate to="/chat" /> : <SignupPage setUser={setUser} publicSettings={publicSettings} />} />

          <Route
            path="/admin"
            element={
              maintenanceMode && !isAdmin
                ? <MaintenancePage message={publicSettings?.welcome_message} />
                : (user ? <AdminDashboard user={user} /> : <Navigate to="/auth" />)
            }
          />
        </Routes>
      </Suspense>
    </Router>
  );
}

export default App;