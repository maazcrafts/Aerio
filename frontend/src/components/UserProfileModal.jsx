import React, { useEffect, useState } from 'react';
import axios from 'axios';
import { motion } from 'framer-motion';
import { X, Mail, Calendar, FileText } from 'lucide-react';
import { API_URL, API_BASE_URL } from '../config';

// Read-only profile viewer for another user, opened by tapping their
// avatar/name in the chat header. Reuses the existing GET /api/profile/:userId
// endpoint (which already applies the viewed user's last-seen privacy setting
// server-side), so no backend changes were needed for this feature.
const UserProfileModal = ({ userId, isOnline, onClose }) => {
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    axios.get(`${API_URL}/profile/${userId}`)
      .then((res) => { if (!cancelled) setProfile(res.data); })
      .catch((err) => { if (!cancelled) setError(err.response?.data?.error || 'Failed to load profile'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [userId]);

  const normalizeUrl = (url) => {
    if (!url) return null;
    if (url.startsWith('http://') || url.startsWith('https://')) return url;
    return `${API_BASE_URL}${url.startsWith('/') ? '' : '/'}${url}`;
  };

  const formatLastSeen = (lastSeen) => {
    if (!lastSeen) return null;
    const d = new Date(lastSeen);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    if (sameDay) return `today at ${time}`;
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    if (d.toDateString() === yesterday.toDateString()) return `yesterday at ${time}`;
    return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} at ${time}`;
  };

  const joinedDate = profile?.created_at
    ? new Date(profile.created_at).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
    : null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <motion.div
        className="modal-content profile-modal user-profile-view-modal"
        initial={{ opacity: 0, scale: 0.95, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 10 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h3>Profile</h3>
          <button type="button" className="close-btn" onClick={onClose}>
            <X size={20} />
          </button>
        </div>

        {loading ? (
          <div className="empty-state">Loading profile...</div>
        ) : error ? (
          <div className="error-text">{error}</div>
        ) : profile ? (
          <>
            <div className="profile-header-section">
              <div className="profile-avatar-container">
                {profile.avatar_url ? (
                  <img src={normalizeUrl(profile.avatar_url)} alt="Avatar" className="profile-avatar-large" />
                ) : (
                  <div className="profile-avatar-placeholder">
                    {(profile.display_name || profile.username || 'U').charAt(0).toUpperCase()}
                  </div>
                )}
                <span
                  className="online-status-dot"
                  style={{
                    left: 2, right: 'auto', bottom: 2, width: 14, height: 14,
                    background: isOnline ? '#10b981' : '#6b7280'
                  }}
                />
              </div>
              <h2 style={{ fontSize: 18, margin: 0 }}>{profile.display_name || profile.username}</h2>
              <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>@{profile.username}</span>
              <span style={{ fontSize: 12, color: isOnline ? '#10b981' : 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 5 }}>
                {isOnline ? (
                  <>
                    <span className="profile-online-text-dot" />
                    Online
                  </>
                ) : profile.last_seen ? (
                  `Last seen ${formatLastSeen(profile.last_seen)}`
                ) : (
                  'Offline'
                )}
              </span>
            </div>

            <div className="profile-form">
              {profile.bio && (
                <div className="form-group">
                  <label><FileText size={14} /> Bio</label>
                  <div className="form-input" style={{ opacity: 0.9, cursor: 'default', minHeight: 20 }}>
                    {profile.bio}
                  </div>
                </div>
              )}

              {joinedDate && (
                <div className="form-group">
                  <label><Calendar size={14} /> Joined</label>
                  <input type="text" className="form-input" value={joinedDate} disabled style={{ opacity: 0.7, cursor: 'not-allowed' }} />
                </div>
              )}
            </div>
          </>
        ) : null}
      </motion.div>
    </div>
  );
};

export default UserProfileModal;