export const DEFAULT_USER_SETTINGS = Object.freeze({
  theme: 'dark',
  accent_color: '#3b82f6',
  notification_sounds: true,
  wallpaper: 'default',
  privacy_last_seen: 'everyone',
  privacy_profile_visibility: 'everyone',
  read_receipts: true,
  typing_indicator: true,
  online_status_visibility: true,
});

export const applyAppearance = (settings = DEFAULT_USER_SETTINGS) => {
  const root = document.documentElement;
  const theme = settings.theme || DEFAULT_USER_SETTINGS.theme;
  const resolvedTheme = theme === 'system'
    ? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
    : theme;
  const accent = settings.accent_color || DEFAULT_USER_SETTINGS.accent_color;

  root.setAttribute('data-theme', resolvedTheme);
  root.style.setProperty('--primary', accent);
  root.style.setProperty('--primary-dark', accent);
  root.style.setProperty('--primary-light', `${accent}26`);
  root.style.setProperty('--glow', `0 0 0 2px ${accent}66`);
  root.style.setProperty('--wallpaper-accent', `${accent}1F`);
  root.setAttribute('data-wallpaper', settings.wallpaper || DEFAULT_USER_SETTINGS.wallpaper);
};

export const getSettingsError = (error, fallback) =>
  error?.response?.data?.error || error?.message || fallback;

// ---------------------------------------------------------------------------
// Local-only settings
//
// These are preferences that do not yet have backend support (no columns on
// user_settings, no enforcement logic). They are kept client-side, per user,
// in localStorage - same pattern already used for caching `chat_user_settings_*`.
// Nothing here is faked as "saved to your account": it lives on this device
// only until backend support is added.
// ---------------------------------------------------------------------------

export const DEFAULT_LOCAL_SETTINGS = Object.freeze({
  // Appearance
  font_size: 'medium',            // small | medium | large
  chat_density: 'comfortable',    // compact | comfortable | spacious
  message_animations: true,
  ui_animations: true,
  // Notifications
  message_notifications: true,
  friend_request_notifications: true,
  group_notifications: true,
  notification_preview: 'show',   // show | hide
  vibration: true,
  // Chat
  enter_to_send: true,
  emoji_reactions: true,
  message_timestamps: 'automatic', // always | automatic
  // Accessibility
  reduce_motion: false,
  larger_text: false,
  high_contrast: false,
});

const localSettingsKey = (userId) => `chat_local_settings_${userId}`;

export const getLocalSettings = (userId) => {
  if (!userId) return { ...DEFAULT_LOCAL_SETTINGS };
  try {
    const raw = localStorage.getItem(localSettingsKey(userId));
    return raw ? { ...DEFAULT_LOCAL_SETTINGS, ...JSON.parse(raw) } : { ...DEFAULT_LOCAL_SETTINGS };
  } catch (_) {
    return { ...DEFAULT_LOCAL_SETTINGS };
  }
};

export const saveLocalSettings = (userId, settings) => {
  if (!userId) return settings;
  try {
    localStorage.setItem(localSettingsKey(userId), JSON.stringify(settings));
  } catch (_) { /* ignore quota errors */ }
  return settings;
};

export const applyLocalAppearance = (settings = DEFAULT_LOCAL_SETTINGS) => {
  const root = document.documentElement;
  const fontSize = settings.larger_text ? 'large' : (settings.font_size || DEFAULT_LOCAL_SETTINGS.font_size);
  root.setAttribute('data-font-size', fontSize);
  root.setAttribute('data-density', settings.chat_density || DEFAULT_LOCAL_SETTINGS.chat_density);
  root.setAttribute('data-message-animations', settings.message_animations === false ? 'off' : 'on');
  root.setAttribute('data-ui-animations', (settings.ui_animations === false || settings.reduce_motion) ? 'off' : 'on');
  root.setAttribute('data-reduce-motion', settings.reduce_motion ? 'on' : 'off');
  root.setAttribute('data-high-contrast', settings.high_contrast ? 'on' : 'off');
  root.setAttribute('data-timestamps', settings.message_timestamps || DEFAULT_LOCAL_SETTINGS.message_timestamps);
};