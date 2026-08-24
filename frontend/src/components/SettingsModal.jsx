import React, { useEffect, useRef, useState } from 'react';
import axios from 'axios';
import { motion as Motion } from 'framer-motion';
import {
  X, Moon, Sun, Monitor, Palette, Image, ShieldCheck, Bell, MessageSquare,
  HardDrive, Accessibility, UserCircle, ChevronDown, ChevronRight,
  Lock, AtSign, Mail, LogOut, Trash2, Camera
} from 'lucide-react';
import { API_URL, API_BASE_URL } from '../config';
import {
  applyAppearance, DEFAULT_USER_SETTINGS, getSettingsError,
  applyLocalAppearance, DEFAULT_LOCAL_SETTINGS, getLocalSettings, saveLocalSettings,
  getCustomWallpaper, setCustomWallpaper, clearCustomWallpaper,
  applyCustomWallpaperVar, compressImageFile,
} from '../utils/appearance';
import { checkNotificationPermission, requestNotificationPermission, sendTestNotification } from '../push';

// Keys that are persisted to the backend (user_settings table).
const SERVER_KEYS = new Set(Object.keys(DEFAULT_USER_SETTINGS));

// ---- small reusable row primitives -----------------------------------

const ToggleRow = ({ label, checked, onChange, disabled }) => (
  <label className={`settings-row toggle-row-item ${disabled ? 'is-disabled' : ''}`}>
    <span>{label}</span>
    <span className={`switch ${checked ? 'on' : ''}`} role="switch" aria-checked={checked}>
      <input type="checkbox" checked={!!checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="switch-knob" />
    </span>
  </label>
);

const SelectRow = ({ label, value, onChange, options, disabled }) => (
  <div className={`settings-row select-row-item ${disabled ? 'is-disabled' : ''}`}>
    <span>{label}</span>
    <select className="form-input settings-select" value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
      {options.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
    </select>
  </div>
);

const NavRow = ({ icon: RowIcon, label, sub, onClick, danger, disabled, disabledNote }) => (
  <button
    type="button"
    className={`settings-row nav-row-item ${danger ? 'is-danger' : ''} ${disabled ? 'is-disabled' : ''}`}
    onClick={disabled ? undefined : onClick}
    disabled={disabled}
  >
    <span className="nav-row-left">
      {RowIcon && <RowIcon size={16} />}
      <span className="nav-row-text">
        <span>{label}</span>
        {sub && <small>{sub}</small>}
        {disabled && disabledNote && <small className="nav-row-note">{disabledNote}</small>}
      </span>
    </span>
    {!disabled && <ChevronRight size={16} />}
  </button>
);

const Section = ({ id, icon: SecIcon, title, open, onToggle, children }) => (
  <div className={`settings-section-block ${open ? 'open' : ''}`}>
    <button type="button" className="settings-section-header" onClick={() => onToggle(id)}>
      <span className="settings-section-title"><SecIcon size={17} /> {title}</span>
      <ChevronDown size={16} className="settings-section-chevron" />
    </button>
    {open && <div className="settings-section-body">{children}</div>}
  </div>
);

// ------------------------------------------------------------------------

const SettingsModal = ({ user, onClose, settings, settingsLoading, onSettingsSaved, onOpenProfile, onLogout }) => {
  const [draft, setDraft] = useState({ ...DEFAULT_USER_SETTINGS, ...DEFAULT_LOCAL_SETTINGS });
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState({ type: '', text: '' });
  const [openSection, setOpenSection] = useState('appearance');
  const [cacheCleared, setCacheCleared] = useState(false);
  const [customAccent, setCustomAccent] = useState('');
  const wallpaperFileInputRef = useRef(null);
  const [wallpaperError, setWallpaperError] = useState('');
  const [wallpaperBusy, setWallpaperBusy] = useState(false);
  const [notifPermission, setNotifPermission] = useState('unknown'); // 'granted' | 'denied' | 'prompt' | 'unsupported' | 'unknown'
  const [notifBusy, setNotifBusy] = useState(false);
  const [testResult, setTestResult] = useState('');

  useEffect(() => {
    let cancelled = false;
    checkNotificationPermission().then((state) => { if (!cancelled) setNotifPermission(state); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    setDraft((current) => ({ ...current, ...DEFAULT_USER_SETTINGS, ...settings }));
  }, [settings]);

  useEffect(() => {
    if (!user?.id) return;
    setDraft((current) => ({ ...current, ...getLocalSettings(user.id) }));
  }, [user?.id]);

  // Save a partial *server* settings update immediately (existing behaviour, untouched).
  const savePartial = async (partial) => {
    if (!user?.id) return;
    setMessage({ type: '', text: '' });
    try {
      const { data } = await axios.put(`${API_URL}/settings/user`, partial);
      const saved = { ...DEFAULT_USER_SETTINGS, ...(data.settings || { ...draft, ...partial }) };
  applyAppearance(saved, user.id);
      onSettingsSaved(saved);
      localStorage.setItem(`chat_user_settings_${user.id}`, JSON.stringify(saved));
      setMessage({ type: 'success', text: 'Settings updated.' });
      setTimeout(() => setMessage({ type: '', text: '' }), 1800);
    } catch (error) {
      setMessage({ type: 'error', text: getSettingsError(error, 'Unable to save settings.') });
    }
  };

  // Save a partial *local-only* preference (no backend support yet - see appearance.js).
  const saveLocalPartial = (partial) => {
    if (!user?.id) return;
    const merged = { ...getLocalSettings(user.id), ...partial };
    saveLocalSettings(user.id, merged);
    applyLocalAppearance(merged);
  };

  const disabled = saving || settingsLoading;

  const updateDraft = (key, value) => {
    setDraft((current) => ({ ...current, [key]: value }));
    if (disabled) return;
    if (SERVER_KEYS.has(key)) {
      savePartial({ [key]: value });
    } else {
      saveLocalPartial({ [key]: value });
    }
  };

  const clearCache = () => {
    if (!user?.id) return;
    try {
      localStorage.removeItem(`chat_contacts_${user.id}`);
      localStorage.removeItem(`chat_groups_${user.id}`);
      setCacheCleared(true);
      setTimeout(() => setCacheCleared(false), 2000);
    } catch (_) { /* ignore */ }
  };

  // ---- Wallpaper: default swatches, gallery picker, reset -------------

  const applyWallpaperMode = (mode) => {
    setWallpaperError('');
    if (mode !== 'custom') clearCustomWallpaper(user?.id);
    applyCustomWallpaperVar(mode === 'custom' ? getCustomWallpaper(user?.id) : null);
    updateDraft('wallpaper', mode);
  };

  const openGalleryPicker = () => {
    setWallpaperError('');
    wallpaperFileInputRef.current?.click();
  };

  const onWallpaperFileChosen = async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = ''; // allow re-selecting the same file later
    if (!file || !user?.id) return;
    if (!file.type.startsWith('image/')) {
      setWallpaperError('Please choose an image file.');
      return;
    }
    setWallpaperBusy(true);
    setWallpaperError('');
    try {
      const dataUrl = await compressImageFile(file);
      setCustomWallpaper(user.id, dataUrl);
      applyCustomWallpaperVar(dataUrl);
      updateDraft('wallpaper', 'custom');
    } catch (err) {
      setWallpaperError(err.message || 'Could not use that image.');
    } finally {
      setWallpaperBusy(false);
    }
  };

  const hasCustomWallpaperSaved = !!(user?.id && getCustomWallpaper(user.id));

  // ---- Notifications: OS permission + real end-to-end test ------------

  const handleEnableNotifications = async () => {
    setNotifBusy(true);
    setTestResult('');
    try {
      const state = await requestNotificationPermission();
      setNotifPermission(state);
    } finally {
      setNotifBusy(false);
    }
  };

  const handleTestNotification = async () => {
    setNotifBusy(true);
    setTestResult('');
    try {
      await sendTestNotification();
      setTestResult('sent');
    } catch (err) {
      setTestResult(getSettingsError(err, 'Failed to send test notification.'));
    } finally {
      setNotifBusy(false);
      setTimeout(() => setTestResult(''), 5000);
    }
  };

  const accentOptions = ['#3b82f6', '#10b981', '#8b5cf6', '#f59e0b', '#ec4899', '#06b6d4', '#ef4444', '#14b8a6'];

  const sections = [
    { id: 'appearance', icon: Palette, title: 'Appearance' },
    { id: 'notifications', icon: Bell, title: 'Notifications' },
    { id: 'privacy', icon: ShieldCheck, title: 'Privacy & Security' },
    { id: 'chat', icon: MessageSquare, title: 'Chat' },
    { id: 'storage', icon: HardDrive, title: 'Storage & Media' },
    { id: 'accessibility', icon: Accessibility, title: 'Accessibility' },
    { id: 'account', icon: UserCircle, title: 'Account' },
  ];

  return (
    <div className="modal-overlay" onClick={onClose}>
      <Motion.div className="modal-content settings-modal settings-modal-v2" initial={{ opacity: 0, scale: 0.95, y: 10 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.95, y: 10 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header settings-modal-header">
          <h3>App Settings</h3>
          <button type="button" className="close-btn" onClick={onClose}><X size={20} /></button>
        </div>

        {message.text && <div className={message.type === 'error' ? 'error-text' : 'success-text'} style={{ margin: '0 20px 10px' }}>{message.text}</div>}

        <div className="settings-body settings-body-v2">
          {sections.map((sec) => (
            <Section key={sec.id} id={sec.id} icon={sec.icon} title={sec.title} open={openSection === sec.id} onToggle={(id) => setOpenSection((cur) => (cur === id ? null : id))}>

              {sec.id === 'appearance' && (
                <>
                  <div className="settings-row-label"><Moon size={14} /> Theme</div>
                  <div className="theme-options">
                    {[['dark', Moon, 'Dark'], ['light', Sun, 'Light'], ['system', Monitor, 'System']].map(([value, ThemeIcon, label]) => (
                      <button key={value} type="button" className={`theme-btn ${draft.theme === value ? 'active' : ''}`} onClick={() => updateDraft('theme', value)} disabled={disabled}><ThemeIcon size={16} /> {label}</button>
                    ))}
                  </div>

                  <div className="settings-row-label" style={{ marginTop: 18 }}><Palette size={14} /> Accent Color</div>
                  <div className="accent-swatches-v2">
                    {accentOptions.map((color) => (
                      <button
                        type="button"
                        key={color}
                        className={`swatch-v2 ${draft.accent_color === color ? 'selected' : ''}`}
                        style={{ backgroundColor: color }}
                        onClick={() => !disabled && updateDraft('accent_color', color)}
                        aria-label={color}
                      >
                        {draft.accent_color === color && <span className="swatch-check">✓</span>}
                      </button>
                    ))}
                    <div className="swatch-custom">
                      <input
                        type="color"
                        className="swatch-custom-input"
                        value={/^#[0-9a-fA-F]{6}$/.test(draft.accent_color) ? draft.accent_color : '#3b82f6'}
                        disabled={disabled}
                        onChange={(e) => updateDraft('accent_color', e.target.value)}
                        title="Custom color"
                      />
                    </div>
                  </div>

                  <div className="settings-row-label" style={{ marginTop: 18 }}><Image size={14} /> Chat Wallpaper</div>
                  <div className="wallpaper-picker">
                    <button type="button" className={`wallpaper-swatch wallpaper-swatch-default ${draft.wallpaper === 'default' ? 'selected' : ''}`} disabled={disabled} onClick={() => applyWallpaperMode('default')}>
                      {draft.wallpaper === 'default' && <span className="swatch-check">✓</span>}
                      <span className="wallpaper-swatch-label">Default</span>
                    </button>
                    <button type="button" className={`wallpaper-swatch wallpaper-swatch-minimal ${draft.wallpaper === 'minimal' ? 'selected' : ''}`} disabled={disabled} onClick={() => applyWallpaperMode('minimal')}>
                      {draft.wallpaper === 'minimal' && <span className="swatch-check">✓</span>}
                      <span className="wallpaper-swatch-label">Minimal</span>
                    </button>
                    <button type="button" className={`wallpaper-swatch wallpaper-swatch-soft ${draft.wallpaper === 'soft' ? 'selected' : ''}`} disabled={disabled} onClick={() => applyWallpaperMode('soft')}>
                      {draft.wallpaper === 'soft' && <span className="swatch-check">✓</span>}
                      <span className="wallpaper-swatch-label">Soft</span>
                    </button>
                    {hasCustomWallpaperSaved && (
                      <button
                        type="button"
                        className={`wallpaper-swatch wallpaper-swatch-custom ${draft.wallpaper === 'custom' ? 'selected' : ''}`}
                        disabled={disabled}
                        style={{ backgroundImage: `url(${getCustomWallpaper(user?.id)})` }}
                        onClick={() => applyWallpaperMode('custom')}
                      >
                        {draft.wallpaper === 'custom' && <span className="swatch-check">✓</span>}
                        <span className="wallpaper-swatch-label">Your Photo</span>
                      </button>
                    )}
                  </div>
                  <input ref={wallpaperFileInputRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={onWallpaperFileChosen} />
                  <div className="wallpaper-actions">
                    <button type="button" className="btn-secondary btn-small" disabled={disabled || wallpaperBusy} onClick={openGalleryPicker}>
                      {wallpaperBusy ? 'Processing…' : 'Choose from Gallery'}
                    </button>
                    {draft.wallpaper !== 'default' && (
                      <button type="button" className="btn-secondary btn-small" disabled={disabled} onClick={() => applyWallpaperMode('default')}>
                        Reset to Default
                      </button>
                    )}
                  </div>
                  {wallpaperError && <div className="error-text" style={{ marginTop: 6 }}>{wallpaperError}</div>}

                  <div style={{ marginTop: 18 }}>
                    <SelectRow label="Font Size" value={draft.font_size} disabled={disabled || draft.larger_text} onChange={(v) => updateDraft('font_size', v)}
                      options={[{ value: 'small', label: 'Small' }, { value: 'medium', label: 'Medium' }, { value: 'large', label: 'Large' }]} />
                    <SelectRow label="Chat Density" value={draft.chat_density} disabled={disabled} onChange={(v) => updateDraft('chat_density', v)}
                      options={[{ value: 'compact', label: 'Compact' }, { value: 'comfortable', label: 'Comfortable' }]} />
                    <ToggleRow label="Message Animations" checked={draft.message_animations} disabled={disabled} onChange={(v) => updateDraft('message_animations', v)} />
                    <ToggleRow label="UI Animations" checked={draft.ui_animations} disabled={disabled} onChange={(v) => updateDraft('ui_animations', v)} />
                  </div>
                  <p className="settings-hint">Theme, accent color, font size, density and animations sync to your account. Wallpaper mode syncs too, but a gallery photo stays on this device.</p>
                </>
              )}

              {sec.id === 'notifications' && (
                <>
                  <div className={`settings-row permission-status-row perm-${notifPermission}`}>
                    <span>
                      Notification Permission
                      <small style={{ display: 'block', opacity: 0.7, fontWeight: 400 }}>
                        {notifPermission === 'granted' && 'Allowed — Aerio can show notifications.'}
                        {notifPermission === 'denied' && 'Blocked in Android system settings.'}
                        {notifPermission === 'prompt' && "Not yet requested — tap Enable to allow notifications."}
                        {notifPermission === 'unsupported' && 'Not available on this platform (web preview).'}
                        {notifPermission === 'unknown' && 'Checking…'}
                      </small>
                    </span>
                    {notifPermission === 'denied' ? (
                      <button type="button" className="btn-secondary btn-small" onClick={handleEnableNotifications} disabled={notifBusy}>
                        Open Settings
                      </button>
                    ) : notifPermission === 'prompt' ? (
                      <button type="button" className="btn-secondary btn-small" onClick={handleEnableNotifications} disabled={notifBusy}>
                        {notifBusy ? 'Requesting…' : 'Enable'}
                      </button>
                    ) : null}
                  </div>

                  <ToggleRow label="Message Notifications" checked={draft.message_notifications} disabled={disabled} onChange={(v) => updateDraft('message_notifications', v)} />
                  <ToggleRow label="Group Notifications" checked={draft.group_notifications} disabled={disabled} onChange={(v) => updateDraft('group_notifications', v)} />
                  <ToggleRow label="Friend Request Notifications" checked={draft.friend_request_notifications} disabled={disabled} onChange={(v) => updateDraft('friend_request_notifications', v)} />
                  <SelectRow label="Notification Preview" value={draft.notification_preview} disabled={disabled} onChange={(v) => updateDraft('notification_preview', v)}
                    options={[{ value: 'show', label: 'Show Message' }, { value: 'hide', label: 'Hide Message' }, { value: 'hide_completely', label: 'Hide Completely' }]} />
                  <ToggleRow label="Notification Sounds" checked={draft.notification_sounds} disabled={disabled} onChange={(v) => updateDraft('notification_sounds', v)} />
                  <div className="settings-row">
                    <span>Notification Sound</span>
                    <span className="text-muted">Aerio (default)</span>
                  </div>
                  <ToggleRow label="Vibration" checked={draft.vibration} disabled={disabled} onChange={(v) => updateDraft('vibration', v)} />

                  {import.meta.env.DEV && (
                    <>
                      <div className="settings-divider" />
                      <NavRow
                        icon={Bell}
                        label={notifBusy ? 'Sending…' : 'Send Test Notification'}
                        sub="Sends a real push through Firebase to this device — verifies sound, vibration and preview."
                        onClick={handleTestNotification}
                        disabled={notifBusy}
                      />
                      {testResult === 'sent' && <p className="settings-hint success-text">Test notification sent — check your notification shade.</p>}
                      {testResult && testResult !== 'sent' && <p className="settings-hint error-text">{testResult}</p>}
                    </>
                  )}
                  <p className="settings-hint">
                    These preferences are enforced on the server: turning a toggle off stops Aerio from sending that
                    kind of push notification to your devices, it isn't just a local mute.
                  </p>
                </>
              )}

              {sec.id === 'privacy' && (
                <>
                  <SelectRow label="Who can see my last seen" value={draft.privacy_last_seen} disabled={disabled} onChange={(v) => updateDraft('privacy_last_seen', v)}
                    options={[{ value: 'everyone', label: 'Everyone' }, { value: 'contacts', label: 'My Contacts' }, { value: 'nobody', label: 'Nobody' }]} />
                  <SelectRow label="Who can see my profile" value={draft.privacy_profile_visibility} disabled={disabled} onChange={(v) => updateDraft('privacy_profile_visibility', v)}
                    options={[{ value: 'everyone', label: 'Everyone' }, { value: 'contacts', label: 'My Contacts' }, { value: 'nobody', label: 'Nobody' }]} />
                  <ToggleRow label="Read Receipts" checked={draft.read_receipts} disabled={disabled} onChange={(v) => updateDraft('read_receipts', v)} />
                  <ToggleRow label="Typing Indicator" checked={draft.typing_indicator} disabled={disabled} onChange={(v) => updateDraft('typing_indicator', v)} />
                  <ToggleRow label="Show Online Status" checked={draft.online_status_visibility} disabled={disabled} onChange={(v) => updateDraft('online_status_visibility', v)} />

                  <div className="settings-divider" />

                  <SelectRow label="Who can message me" value="everyone" disabled options={[{ value: 'everyone', label: 'Everyone' }, { value: 'friends', label: 'Friends' }]} />
                  <SelectRow label="Who can send me friend requests" value="everyone" disabled options={[{ value: 'everyone', label: 'Everyone' }, { value: 'fof', label: 'Friends of Friends' }]} />
                  <SelectRow label="Who can add me to groups" value="everyone" disabled options={[{ value: 'everyone', label: 'Everyone' }, { value: 'friends', label: 'Friends' }]} />
                  <SelectRow label="Profile Photo Visibility" value="everyone" disabled options={[{ value: 'everyone', label: 'Everyone' }, { value: 'friends', label: 'Friends' }, { value: 'nobody', label: 'Nobody' }]} />
                  <NavRow icon={ShieldCheck} label="Blocked Users" disabled disabledNote="Needs a blocked-users table and endpoints on the backend" onClick={() => {}} />
                  <p className="settings-hint">
                    These controls need new backend support (extra columns and enforcement in the messaging/friend-request
                    logic) that doesn't exist yet, so they're shown disabled rather than pretending to work.
                  </p>
                </>
              )}

              {sec.id === 'chat' && (
                <>
                  <ToggleRow label="Enter to Send" checked={draft.enter_to_send} disabled={disabled} onChange={(v) => updateDraft('enter_to_send', v)} />
                  <ToggleRow label="Emoji Reactions" checked={draft.emoji_reactions} disabled={disabled} onChange={(v) => updateDraft('emoji_reactions', v)} />
                  <SelectRow label="Message Timestamps" value={draft.message_timestamps} disabled={disabled} onChange={(v) => updateDraft('message_timestamps', v)}
                    options={[{ value: 'always', label: 'Always' }, { value: 'automatic', label: 'Automatic' }]} />
                  <SelectRow label="Link Previews" value="off" disabled options={[{ value: 'off', label: 'Off' }, { value: 'on', label: 'On' }]} />
                  <SelectRow label="Auto-download Media" value="wifi" disabled options={[{ value: 'wifi', label: 'Wi-Fi' }, { value: 'mobile', label: 'Mobile Data' }, { value: 'never', label: 'Never' }]} />
                  <ToggleRow label="Send Media in Original Quality" checked={false} disabled onChange={() => {}} />
                  <p className="settings-hint">
                    Enter to Send, Emoji Reactions and Message Timestamps are wired up and save on this device.
                    Link previews, auto-download rules and original-quality uploads need new media-handling work
                    (fetching link metadata, compressing/uploading originals) that hasn't been built yet.
                  </p>
                </>
              )}

              {sec.id === 'storage' && (
                <>
                  <div className="storage-usage-list">
                    {['Images', 'Videos', 'Files', 'Cached Data'].map((label) => (
                      <div className="settings-row storage-row" key={label}>
                        <span>{label}</span>
                        <span className="text-muted">—</span>
                      </div>
                    ))}
                  </div>
                  <NavRow icon={HardDrive} label="Manage Storage" disabled disabledNote="No storage-usage API yet" onClick={() => {}} />
                  <NavRow icon={Image} label="Manage Media" disabled disabledNote="No media-management API yet" onClick={() => {}} />
                  <NavRow icon={Trash2} label={cacheCleared ? 'Cache cleared' : 'Clear Cache'} onClick={clearCache} />
                  <p className="settings-hint">
                    There's no backend endpoint yet to calculate real storage usage, so the numbers above are left
                    blank instead of being made up. "Clear Cache" is real - it clears this app's locally cached
                    contacts/groups list, which will simply be re-fetched next time you load them.
                  </p>
                </>
              )}

              {sec.id === 'accessibility' && (
                <>
                  <ToggleRow label="Reduce Motion" checked={draft.reduce_motion} disabled={disabled} onChange={(v) => updateDraft('reduce_motion', v)} />
                  <ToggleRow label="Larger Text" checked={draft.larger_text} disabled={disabled} onChange={(v) => updateDraft('larger_text', v)} />
                  <ToggleRow label="High Contrast" checked={draft.high_contrast} disabled={disabled} onChange={(v) => updateDraft('high_contrast', v)} />
                  <p className="settings-hint">Saved on this device. Larger Text overrides the Font Size choice above while it's on.</p>
                </>
              )}

              {sec.id === 'account' && (
                <>
                  <div className="account-summary-row">
                    {user?.avatar_url ? (
                      <img src={user.avatar_url.startsWith('http') ? user.avatar_url : `${API_BASE_URL}${user.avatar_url.startsWith('/') ? '' : '/'}${user.avatar_url}`} alt="" className="account-avatar" />
                    ) : (
                      <div className="account-avatar account-avatar-placeholder">{(user?.display_name || user?.username || 'U').charAt(0).toUpperCase()}</div>
                    )}
                    <div>
                      <div className="account-name">{user?.display_name || user?.username}</div>
                      <div className="account-email text-muted">{user?.email || 'No email on file'}</div>
                    </div>
                  </div>

                  <NavRow icon={UserCircle} label="Edit Profile" onClick={() => onOpenProfile && onOpenProfile()} />
                  <NavRow icon={AtSign} label="Change Username" onClick={() => onOpenProfile && onOpenProfile()} />
                  <NavRow icon={Mail} label="Change Email" disabled disabledNote="Backend doesn't support changing email yet" onClick={() => {}} />
                  <NavRow icon={Lock} label="Change Password" onClick={() => onOpenProfile && onOpenProfile(true)} />
                  <NavRow icon={Camera} label="Profile Picture" onClick={() => onOpenProfile && onOpenProfile()} />
                  <NavRow icon={ShieldCheck} label="Blocked Users" disabled disabledNote="Needs a blocked-users table and endpoints on the backend" onClick={() => {}} />

                  <div className="settings-divider" />

                  <NavRow icon={LogOut} label="Log Out" onClick={() => { onLogout && onLogout(); onClose(); }} />
                  <NavRow icon={Trash2} label="Delete Account" danger disabled disabledNote="No delete-account endpoint on the backend yet" onClick={() => {}} />
                </>
              )}
            </Section>
          ))}
        </div>
      </Motion.div>
    </div>
  );
};

export default SettingsModal;