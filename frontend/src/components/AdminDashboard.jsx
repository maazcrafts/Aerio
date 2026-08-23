import React, { useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import { Users, MessageSquare, Settings, Shield, Trash2, Ban, CheckCircle, Megaphone, Search } from 'lucide-react';
import { API_URL } from '../config';

const BarChart = ({ title, data }) => {
  const max = Math.max(1, ...data.map(d => d.count));
  return (
    <div className="admin-card">
      <div className="admin-card-title">{title}</div>
      <div className="admin-chart">
        {data.map((d) => (
          <div key={d.day} className="admin-bar">
            <div className="admin-bar-fill" style={{ height: `${(d.count / max) * 100}%` }} />
            <div className="admin-bar-label">{d.day.slice(5)}</div>
          </div>
        ))}
      </div>
    </div>
  );
};

const AdminDashboard = ({ user }) => {
  const [tab, setTab] = useState('overview');
  const [stats, setStats] = useState(null);
  const [users, setUsers] = useState([]);
  const [messages, setMessages] = useState([]);
  const [settings, setSettings] = useState(null);
  const [broadcastText, setBroadcastText] = useState('');
  const [searchFilter, setSearchFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const isAdmin = useMemo(() => user?.username === 'maaz_khan' || user?.role === 'admin', [user]);

  useEffect(() => {
    if (!isAdmin) return;
    const run = async () => {
      try {
        const [s, set] = await Promise.all([
          axios.get(`${API_URL}/admin/dashboard/stats`),
          axios.get(`${API_URL}/admin/dashboard/settings`)
        ]);
        setStats(s.data);
        setSettings(set.data);
      } catch (e) {
        // noop
      }
    };
    run();
  }, [isAdmin]);

  const loadUsers = async () => {
    try {
      const res = await axios.get(`${API_URL}/admin/dashboard/users`);
      setUsers(res.data || []);
    } catch (_) {}
  };

  const loadMessages = async () => {
    try {
      const res = await axios.get(`${API_URL}/admin/dashboard/messages?limit=120`);
      setMessages(res.data || []);
    } catch (_) {}
  };

  useEffect(() => {
    if (!isAdmin) return;
    if (tab === 'users') loadUsers();
    if (tab === 'messages') loadMessages();
  }, [tab, isAdmin]);

  if (!isAdmin) {
    return (
      <div className="app-container">
        <div className="auth-card" style={{ maxWidth: 520 }}>
          <div className="auth-header">
            <h1>Admin</h1>
            <p>Access denied</p>
          </div>
          <div className="error-text">You do not have permission to view this page.</div>
        </div>
      </div>
    );
  }

  const totals = stats?.totals || { users: 0, messages: 0, groups: 0, activeUsersToday: 0 };
  const series = stats?.series || { messagesPerDay: [], signupsPerDay: [] };

  const filteredUsers = users.filter(u => 
    u.username?.toLowerCase().includes(searchFilter.toLowerCase()) ||
    u.display_name?.toLowerCase().includes(searchFilter.toLowerCase()) ||
    u.email?.toLowerCase().includes(searchFilter.toLowerCase())
  );

  return (
    <div className="app-container" style={{ alignItems: 'stretch' }}>
      <div className="admin-shell">
        <div className="admin-sidebar">
          <div className="admin-brand">
            <Shield size={18} />
            <span>Admin Control Panel</span>
          </div>

          <button className={`admin-nav ${tab === 'overview' ? 'active' : ''}`} onClick={() => setTab('overview')}>
            <Settings size={16} /> Overview
          </button>
          <button className={`admin-nav ${tab === 'users' ? 'active' : ''}`} onClick={() => setTab('users')}>
            <Users size={16} /> Users
          </button>
          <button className={`admin-nav ${tab === 'messages' ? 'active' : ''}`} onClick={() => setTab('messages')}>
            <MessageSquare size={16} /> Messages
          </button>
          <button className={`admin-nav ${tab === 'controls' ? 'active' : ''}`} onClick={() => setTab('controls')}>
            <Settings size={16} /> App controls
          </button>
          <button className={`admin-nav ${tab === 'broadcast' ? 'active' : ''}`} onClick={() => setTab('broadcast')}>
            <Megaphone size={16} /> Broadcast
          </button>
        </div>

        <div className="admin-main">
          {tab === 'overview' && (
            <>
              <div className="admin-grid">
                <div className="admin-card">
                  <div className="admin-metric-label">Total users</div>
                  <div className="admin-metric">{totals.users}</div>
                </div>
                <div className="admin-card">
                  <div className="admin-metric-label">Total messages</div>
                  <div className="admin-metric">{totals.messages}</div>
                </div>
                <div className="admin-card">
                  <div className="admin-metric-label">Total groups</div>
                  <div className="admin-metric">{totals.groups}</div>
                </div>
                <div className="admin-card">
                  <div className="admin-metric-label">Active users (24h)</div>
                  <div className="admin-metric">{totals.activeUsersToday}</div>
                </div>
              </div>

              <div className="admin-grid-2">
                <BarChart title="Messages per day (14d)" data={series.messagesPerDay} />
                <BarChart title="New signups per day (14d)" data={series.signupsPerDay} />
              </div>
            </>
          )}

          {tab === 'users' && (
            <div className="admin-card">
              <div className="admin-card-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span>Users ({filteredUsers.length})</span>
                <div className="admin-search-input-wrap">
                  <Search size={14} color="var(--text-muted)" />
                  <input
                    type="text"
                    placeholder="Search users..."
                    value={searchFilter}
                    onChange={(e) => setSearchFilter(e.target.value)}
                    className="admin-search-input"
                  />
                </div>
              </div>

              <div className="admin-table-wrap">
                <table className="admin-table">
                  <thead>
                    <tr>
                      <th>User</th>
                      <th>Email</th>
                      <th>Role</th>
                      <th>Last seen</th>
                      <th>Online</th>
                      <th>Status</th>
                      <th style={{ width: 220 }}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredUsers.map(u => (
                      <tr key={u.id}>
                        <td>
                          <strong>{u.display_name || u.username}</strong>
                          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>@{u.username}</div>
                        </td>
                        <td className="mono">{u.email || 'N/A'}</td>
                        <td>{u.role || 'user'}</td>
                        <td className="mono">{u.last_seen ? new Date(u.last_seen).toLocaleDateString() : '-'}</td>
                        <td>{u.online ? <span className="pill ok">Online</span> : <span className="pill">Offline</span>}</td>
                        <td>{u.banned ? <span className="pill danger">Banned</span> : <span className="pill ok">Active</span>}</td>
                        <td>
                          <div className="admin-actions">
                            <button
                              className="admin-btn"
                              onClick={async () => {
                                await axios.post(`${API_URL}/admin/dashboard/users/${u.id}/ban`, { banned: !u.banned });
                                await loadUsers();
                              }}
                            >
                              {u.banned ? <CheckCircle size={14} /> : <Ban size={14} />}
                              {u.banned ? 'Unban' : 'Ban'}
                            </button>
                            <button
                              className="admin-btn danger"
                              onClick={async () => {
                                if (!confirm(`Delete user ${u.username}? This removes their messages/contacts.`)) return;
                                await axios.delete(`${API_URL}/admin/dashboard/users/${u.id}`);
                                await loadUsers();
                              }}
                            >
                              <Trash2 size={14} /> Delete
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {tab === 'messages' && (
            <div className="admin-card">
              <div className="admin-card-title">Recent messages</div>
              <div className="admin-table-wrap">
                <table className="admin-table">
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>From</th>
                      <th>To / Group</th>
                      <th>Type</th>
                      <th>Content</th>
                      <th style={{ width: 120 }}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {messages.map(m => (
                      <tr key={m.id}>
                        <td className="mono">{new Date(m.timestamp).toLocaleTimeString()}</td>
                        <td className="mono">{m.sender_username || m.sender_id}</td>
                        <td className="mono">{m.group_id ? `#${m.group_name || m.group_id}` : (m.receiver_username || m.receiver_id)}</td>
                        <td>{m.type}</td>
                        <td className="truncate">{m.type === 'text' || m.type === 'system' ? (m.content || '') : (m.image_url || '')}</td>
                        <td>
                          <button
                            className="admin-btn danger"
                            onClick={async () => {
                              if (!confirm(`Delete message ${m.id}?`)) return;
                              await axios.delete(`${API_URL}/admin/dashboard/messages/${m.id}`);
                              await loadMessages();
                            }}
                          >
                            <Trash2 size={14} /> Delete
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {tab === 'controls' && settings && (
            <div className="admin-card">
              <div className="admin-card-title">App controls</div>
              <div className="admin-form">
                <label className="admin-toggle">
                  <input
                    type="checkbox"
                    checked={!!settings.maintenance_mode}
                    onChange={(e) => setSettings(s => ({ ...s, maintenance_mode: e.target.checked }))}
                  />
                  <span>Maintenance mode</span>
                </label>
                <label className="admin-toggle">
                  <input
                    type="checkbox"
                    checked={!!settings.invite_only}
                    onChange={(e) => setSettings(s => ({ ...s, invite_only: e.target.checked }))}
                  />
                  <span>Invite-only registrations</span>
                </label>
                <div className="admin-field">
                  <div className="admin-field-label">Welcome message</div>
                  <input
                    className="form-input"
                    value={settings.welcome_message || ''}
                    onChange={(e) => setSettings(s => ({ ...s, welcome_message: e.target.value }))}
                  />
                </div>
                <button
                  className="btn-primary"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await axios.put(`${API_URL}/admin/dashboard/settings`, settings);
                      const refreshed = await axios.get(`${API_URL}/admin/dashboard/settings`);
                      setSettings(refreshed.data);
                      alert('Saved');
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  Save controls
                </button>
              </div>
            </div>
          )}

          {tab === 'broadcast' && (
            <div className="admin-card">
              <div className="admin-card-title">Broadcast announcement</div>
              <div className="admin-form">
                <textarea
                  className="admin-textarea"
                  rows={4}
                  placeholder="Write a system announcement to all users…"
                  value={broadcastText}
                  onChange={(e) => setBroadcastText(e.target.value)}
                />
                <button
                  className="btn-primary"
                  disabled={busy || !broadcastText.trim()}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await axios.post(`${API_URL}/admin/dashboard/broadcast`, { content: broadcastText });
                      setBroadcastText('');
                      alert('Broadcast sent');
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  Send broadcast
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default AdminDashboard;
