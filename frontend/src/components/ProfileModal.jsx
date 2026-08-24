import React, { useState } from 'react';
import axios from 'axios';
import { motion } from 'framer-motion';
import { X, Camera, Trash2, Key, User, Mail, Calendar, FileText } from 'lucide-react';
import { API_URL, API_BASE_URL } from '../config';

const ProfileModal = ({ user, setUser, onClose, initialShowPassword = false }) => {
  const [displayName, setDisplayName] = useState(user.display_name || user.username || '');
  const [username, setUsername] = useState(user.username || '');
  const [bio, setBio] = useState(user.bio || '');
  const [avatarUrl, setAvatarUrl] = useState(user.avatar_url || null);
  const [showPasswordSection, setShowPasswordSection] = useState(initialShowPassword);
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [message, setMessage] = useState({ type: '', text: '' });
  const [loading, setLoading] = useState(false);

  const normalizeUrl = (url) => {
    if (!url) return null;
    if (url.startsWith('http://') || url.startsWith('https://')) return url;
    return `${API_BASE_URL}${url.startsWith('/') ? '' : '/'}${url}`;
  };

  const handleAvatarUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const formData = new FormData();
    formData.append('file', file);
    setLoading(true);
    setMessage({ type: '', text: '' });

    try {
      const res = await axios.post(`${API_URL}/profile/avatar`, formData, {
        headers: { 'Content-Type': 'multipart/form-data' }
      });
      setAvatarUrl(res.data.avatar_url);
      const updatedUser = { ...user, avatar_url: res.data.avatar_url };
      setUser(updatedUser);
      localStorage.setItem('chat_user', JSON.stringify(updatedUser));
      setMessage({ type: 'success', text: 'Profile picture updated!' });
    } catch (err) {
      setMessage({ type: 'error', text: err.response?.data?.error || 'Failed to upload picture' });
    } finally {
      setLoading(false);
    }
  };

  const handleAvatarDelete = async () => {
    setLoading(true);
    setMessage({ type: '', text: '' });
    try {
      await axios.delete(`${API_URL}/profile/avatar`);
      setAvatarUrl(null);
      const updatedUser = { ...user, avatar_url: null };
      setUser(updatedUser);
      localStorage.setItem('chat_user', JSON.stringify(updatedUser));
      setMessage({ type: 'success', text: 'Profile picture removed.' });
    } catch (err) {
      setMessage({ type: 'error', text: 'Failed to remove picture' });
    } finally {
      setLoading(false);
    }
  };

  const handleSaveProfile = async (e) => {
    e.preventDefault();
    setMessage({ type: '', text: '' });

    if (newPassword && newPassword !== confirmPassword) {
      return setMessage({ type: 'error', text: 'New passwords do not match' });
    }

    setLoading(true);
    try {
      const res = await axios.put(`${API_URL}/profile/update`, {
        username,
        display_name: displayName,
        bio,
        oldPassword: newPassword ? oldPassword : undefined,
        newPassword: newPassword ? newPassword : undefined
      });

      const updatedUser = { ...user, ...res.data };
      setUser(updatedUser);
      localStorage.setItem('chat_user', JSON.stringify(updatedUser));
      if (res.data.token) {
        axios.defaults.headers.common['Authorization'] = `Bearer ${res.data.token}`;
      }
      setMessage({ type: 'success', text: 'Profile updated successfully!' });
      setOldPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setShowPasswordSection(false);
    } catch (err) {
      setMessage({ type: 'error', text: err.response?.data?.error || 'Failed to update profile' });
    } finally {
      setLoading(false);
    }
  };

  const joinedDate = user.created_at ? new Date(user.created_at).toLocaleDateString(undefined, { month: 'long', year: 'numeric' }) : 'Recently';

  return (
    <div className="modal-overlay" onClick={onClose}>
      <motion.div 
        className="modal-content profile-modal"
        initial={{ opacity: 0, scale: 0.95, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 10 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h3>Profile Settings</h3>
          <button type="button" className="close-btn" onClick={onClose}>
            <X size={20} />
          </button>
        </div>

        {message.text && (
          <div className={message.type === 'error' ? 'error-text' : 'success-text'} style={{ marginBottom: 15 }}>
            {message.text}
          </div>
        )}

        <div className="profile-header-section">
          <div className="profile-avatar-container">
            {avatarUrl ? (
              <img src={normalizeUrl(avatarUrl)} alt="Avatar" className="profile-avatar-large" />
            ) : (
              <div className="profile-avatar-placeholder">
                {(displayName || username || 'U').charAt(0).toUpperCase()}
              </div>
            )}
            <span className="online-status-dot" style={{ left: 2, right: 'auto', bottom: 2, width: 14, height: 14 }} />
            <label className="avatar-edit-badge" title="Change Photo">
              <Camera size={14} />
              <input type="file" accept="image/*" onChange={handleAvatarUpload} style={{ display: 'none' }} />
            </label>
          </div>
          {avatarUrl && (
            <button type="button" className="avatar-delete-btn" onClick={handleAvatarDelete} title="Remove Photo">
              <Trash2 size={14} /> Remove Photo
            </button>
          )}
        </div>

        <form onSubmit={handleSaveProfile} className="profile-form">
          <div className="form-group">
            <label><User size={14} /> Display Name</label>
            <input 
              type="text" 
              className="form-input"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Your Name"
              required
            />
          </div>

          <div className="form-group">
            <label><User size={14} /> Username</label>
            <input 
              type="text" 
              className="form-input"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="username"
              required
            />
          </div>

          <div className="form-group">
            <label><FileText size={14} /> Bio</label>
            <textarea 
              className="form-input"
              rows={2}
              value={bio}
              onChange={(e) => setBio(e.target.value)}
              placeholder="Write something about yourself..."
            />
          </div>

          <div className="form-group">
            <label><Mail size={14} /> Email</label>
            <input 
              type="email" 
              className="form-input"
              value={user.email || 'N/A'}
              disabled
              style={{ opacity: 0.7, cursor: 'not-allowed' }}
            />
          </div>

          <div className="form-group">
            <label><Calendar size={14} /> Joined</label>
            <input 
              type="text" 
              className="form-input"
              value={joinedDate}
              disabled
              style={{ opacity: 0.7, cursor: 'not-allowed' }}
            />
          </div>

          <div className="password-toggle-section">
            <button 
              type="button" 
              className="btn-secondary"
              onClick={() => setShowPasswordSection(!showPasswordSection)}
              style={{ width: '100%', marginBottom: 15, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}
            >
              <Key size={16} /> {showPasswordSection ? 'Cancel Password Change' : 'Change Password'}
            </button>

            {showPasswordSection && (
              <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }}>
                <div className="form-group">
                  <label>Current Password</label>
                  <input 
                    type="password"
                    className="form-input"
                    value={oldPassword}
                    onChange={(e) => setOldPassword(e.target.value)}
                    placeholder="Enter current password"
                  />
                </div>
                <div className="form-group">
                  <label>New Password</label>
                  <input 
                    type="password"
                    className="form-input"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder="Enter new password"
                  />
                </div>
                <div className="form-group">
                  <label>Confirm New Password</label>
                  <input 
                    type="password"
                    className="form-input"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="Confirm new password"
                  />
                </div>
              </motion.div>
            )}
          </div>

          <button type="submit" className="btn-primary" disabled={loading}>
            {loading ? 'Saving...' : 'Save Changes'}
          </button>
        </form>
      </motion.div>
    </div>
  );
};

export default ProfileModal;