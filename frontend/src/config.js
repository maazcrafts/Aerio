console.log("VITE_API_URL:", import.meta.env.VITE_API_URL);

const getBaseUrl = () => {
  if (import.meta.env.VITE_API_URL) {
    return import.meta.env.VITE_API_URL;
  }

  // No VITE_API_URL at build time — fall back to production, never to a
  // personal LAN/dev address. A LAN fallback here only ever "works" on the
  // developer's own network and silently breaks the app for every other
  // device that installs the same APK.
  return "https://aerio-backend.onrender.com";
};

export const API_BASE_URL = getBaseUrl();
export const API_URL = `${API_BASE_URL}/api`;
export const SOCKET_URL = API_BASE_URL;

// ── WebRTC TURN relay (optional) ────────────────────────────────────────
// STUN (Google's public servers, hardcoded in ChatDashboard.jsx) is enough
// to establish most calls, but it cannot traverse symmetric/carrier-grade
// NAT — which is common on mobile networks, so two phones on different
// carriers/networks can fail to connect to each other with STUN alone.
// A TURN relay fixes that, at the cost of running through a relay server
// instead of peer-to-peer. This is entirely optional and off by default —
// set these three env vars (in .env for local/dev builds, or your hosting
// provider's env var settings for production/CI builds) to turn it on.
// Never hardcode real TURN credentials in source; these come from env vars
// specifically so they aren't committed to the repo.
export const TURN_URL = import.meta.env.VITE_TURN_URL || '';
export const TURN_USERNAME = import.meta.env.VITE_TURN_USERNAME || '';
export const TURN_CREDENTIAL = import.meta.env.VITE_TURN_CREDENTIAL || '';

// Pre-built ICE server entry, or null if TURN isn't configured — so callers
// don't have to duplicate the "is this actually configured" check.
export const TURN_ICE_SERVER = (TURN_URL && TURN_USERNAME && TURN_CREDENTIAL)
  ? {
      urls: TURN_URL.split(',').map(u => u.trim()).filter(Boolean),
      username: TURN_USERNAME,
      credential: TURN_CREDENTIAL
    }
  : null;