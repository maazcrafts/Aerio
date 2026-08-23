import React from 'react';
import { WifiOff, AlertTriangle, Clock3, SearchX, RefreshCw, LogIn, Image as ImageIcon } from 'lucide-react';
import './UIStates.css';

/**
 * Reusable UI-state components used across Aerio for loading, error,
 * offline, slow-network, empty-search and session-expiry situations.
 * Every component is presentational only — callers decide when to show
 * it and what the retry/login actions actually do.
 */

// ── 1. Loading / Skeleton ───────────────────────────────────────────────

// A single skeleton "card" shaped like a contact/group row.
export const ContactsSkeleton = ({ rows = 6 }) => (
  <div className="ui-skeleton-list" aria-busy="true" aria-label="Loading conversations">
    {Array.from({ length: rows }).map((_, i) => (
      <div className="ui-skeleton-row" key={i}>
        <div className="ui-skeleton shimmer ui-skeleton-avatar" />
        <div className="ui-skeleton-row-lines">
          <div className="ui-skeleton shimmer ui-skeleton-line" style={{ width: '55%' }} />
          <div className="ui-skeleton shimmer ui-skeleton-line" style={{ width: '80%' }} />
        </div>
      </div>
    ))}
  </div>
);

// Skeleton shaped like a run of chat bubbles, mirroring the reference
// "image block + text lines" loading card.
export const MessagesSkeleton = () => (
  <div className="ui-skeleton-messages" aria-busy="true" aria-label="Loading messages">
    <div className="ui-skeleton shimmer ui-skeleton-media">
      <ImageIcon size={28} className="ui-skeleton-media-icon" />
    </div>
    {[['62%', '30%'], ['85%'], ['70%', '25%'], ['45%']].map((widths, i) => (
      <div className="ui-skeleton-bubble-lines" key={i}>
        {widths.map((w, j) => (
          <div className="ui-skeleton shimmer ui-skeleton-line" style={{ width: w }} key={j} />
        ))}
      </div>
    ))}
    <div className="ui-skeleton-spinner-wrap">
      <span className="ui-spinner" />
    </div>
  </div>
);

// ── 2. Error state ──────────────────────────────────────────────────────

export const ErrorState = ({
  title = 'Something went wrong!',
  message = "We couldn't load the data. Please try again.",
  onRetry,
  retryLabel = 'Try Again',
  compact = false,
}) => (
  <div className={`ui-state ${compact ? 'ui-state-compact' : ''}`} role="alert">
    <div className="ui-state-icon ui-state-icon-danger">
      <AlertTriangle size={compact ? 26 : 34} />
    </div>
    <h3 className="ui-state-title">{title}</h3>
    <p className="ui-state-message">{message}</p>
    {onRetry && (
      <button type="button" className="ui-state-btn ui-state-btn-danger" onClick={onRetry}>
        <RefreshCw size={15} /> {retryLabel}
      </button>
    )}
  </div>
);

// ── 3. No internet connection ───────────────────────────────────────────

export const NoInternetState = ({ onRetry, compact = false }) => (
  <div className={`ui-state ${compact ? 'ui-state-compact' : ''}`} role="alert">
    <div className="ui-state-icon ui-state-icon-muted">
      <WifiOff size={compact ? 26 : 34} />
    </div>
    <h3 className="ui-state-title">No Internet Connection</h3>
    <p className="ui-state-message">Please check your internet connection and try again.</p>
    {onRetry && (
      <button type="button" className="ui-state-btn ui-state-btn-primary" onClick={onRetry}>
        Retry
      </button>
    )}
  </div>
);

// Slim, non-blocking bar for when the app is already loaded and just lost
// connectivity — shown fixed to the top of the viewport, doesn't cover UI.
export const OfflineBanner = ({ visible }) => {
  if (!visible) return null;
  return (
    <div className="ui-offline-banner" role="status">
      <WifiOff size={14} />
      <span>You're offline — some features may not work.</span>
    </div>
  );
};

// ── 4. Slow network ─────────────────────────────────────────────────────

export const SlowNetworkState = ({ compact = false }) => (
  <div className={`ui-state ${compact ? 'ui-state-compact' : ''}`} role="status">
    <div className="ui-state-icon ui-state-icon-info ui-snail-bounce">
      <Clock3 size={compact ? 24 : 30} />
    </div>
    <h3 className="ui-state-title">It's taking longer than usual</h3>
    <p className="ui-state-message">You're on a slow connection. Please wait&hellip;</p>
    <div className="ui-progress-track">
      <div className="ui-progress-fill" />
    </div>
  </div>
);

// ── 5. No search results ────────────────────────────────────────────────

export const NoResultsState = ({ query = '', onClear, compact = false }) => (
  <div className={`ui-state ${compact ? 'ui-state-compact' : ''}`}>
    <div className="ui-state-icon ui-state-icon-muted">
      <SearchX size={compact ? 24 : 32} />
    </div>
    <h3 className="ui-state-title">No results found</h3>
    <p className="ui-state-message">
      {query ? <>We couldn't find anything for &ldquo;{query}&rdquo;. Try different keywords.</> : 'Try different keywords.'}
    </p>
    {onClear && (
      <button type="button" className="ui-state-btn ui-state-btn-primary" onClick={onClear}>
        Clear Search
      </button>
    )}
  </div>
);

// ── 6. Session expired ──────────────────────────────────────────────────

export const SessionExpiredState = ({ onLoginAgain }) => (
  <div className="ui-session-expired-overlay">
    <div className="ui-state">
      <div className="ui-state-icon ui-state-icon-warning">
        <Clock3 size={34} />
      </div>
      <h3 className="ui-state-title">Session Expired</h3>
      <p className="ui-state-message">Your session has expired for security reasons. Please log in again to continue.</p>
      <button type="button" className="ui-state-btn ui-state-btn-warning" onClick={onLoginAgain}>
        <LogIn size={15} /> Log In Again
      </button>
    </div>
  </div>
);