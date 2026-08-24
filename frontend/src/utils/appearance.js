// Server-backed settings: synced to the account via /api/settings/user, so
// they follow the user across a re-login or reinstall on any device.
export const DEFAULT_USER_SETTINGS = Object.freeze({
  theme: 'dark',
  accent_color: '#3b82f6',
  notification_sounds: true,
  wallpaper: 'default', // 'default' | 'minimal' | 'soft' | 'custom'
  privacy_last_seen: 'everyone',
  privacy_profile_visibility: 'everyone',
  read_receipts: true,
  typing_indicator: true,
  online_status_visibility: true,
  // Notification preferences — these actually gate whether the backend
  // calls push.sendToUser() for this user (see server.js). They used to
  // live in localStorage only, which meant toggling them never changed
  // what push notifications you received.
  message_notifications: true,
  group_notifications: true,
  friend_request_notifications: true,
  notification_preview: 'show', // 'show' | 'hide' | 'hide_completely'
  vibration: true,
  // Appearance fields worth syncing across devices.
  font_size: 'medium',       // small | medium | large
  chat_density: 'comfortable', // compact | comfortable
  message_animations: true,
  ui_animations: true,
});

export const applyAppearance = (settings = DEFAULT_USER_SETTINGS, userId) => {
  const root = document.documentElement;
  const theme = settings.theme || DEFAULT_USER_SETTINGS.theme;
  const resolvedTheme = theme === 'system'
    ? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
    : theme;
  const accent = settings.accent_color || DEFAULT_USER_SETTINGS.accent_color;

  root.setAttribute('data-theme', resolvedTheme);
  root.style.setProperty('--primary', accent);
  root.style.setProperty('--primary-dark', shadeColor(accent, -12));
  root.style.setProperty('--primary-light', `${accent}26`);
  root.style.setProperty('--glow', `0 0 0 2px ${accent}66`);
  root.style.setProperty('--wallpaper-accent', `${accent}1F`);

  const wallpaper = settings.wallpaper || DEFAULT_USER_SETTINGS.wallpaper;
  root.setAttribute('data-wallpaper', wallpaper);
  if (wallpaper === 'custom' && userId) {
    applyCustomWallpaperVar(getCustomWallpaper(userId));
  } else if (wallpaper !== 'custom') {
    applyCustomWallpaperVar(null);
  }

  const fontSize = settings.font_size || DEFAULT_USER_SETTINGS.font_size;
  root.setAttribute('data-font-size', fontSize);

  const density = settings.chat_density || DEFAULT_USER_SETTINGS.chat_density;
  root.setAttribute('data-density', density);

  root.setAttribute('data-message-animations', settings.message_animations === false ? 'off' : 'on');
  root.setAttribute('data-ui-animations', settings.ui_animations === false ? 'off' : 'on');
};

// Darkens (negative percent) or lightens (positive) a #rrggbb hex color.
// Used to derive a hover/active shade of the user's accent color without
// asking them to pick two colors.
function shadeColor(hex, percent) {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return hex;
  const num = parseInt(hex.slice(1), 16);
  const amt = Math.round(2.55 * percent);
  const r = Math.min(255, Math.max(0, (num >> 16) + amt));
  const g = Math.min(255, Math.max(0, ((num >> 8) & 0x00ff) + amt));
  const b = Math.min(255, Math.max(0, (num & 0x0000ff) + amt));
  return `#${(0x1000000 + r * 0x10000 + g * 0x100 + b).toString(16).slice(1)}`;
}

export const getSettingsError = (error, fallback) =>
  error?.response?.data?.error || error?.message || fallback;

// ---------------------------------------------------------------------------
// Custom wallpaper image (device-local only)
//
// A gallery-picked wallpaper is a real image, not a small enum value, so it
// isn't synced through /api/settings/user like the rest of appearance (that
// endpoint only stores small text/boolean columns). It's downscaled +
// compressed client-side and cached in localStorage per-user, the same
// pattern already used for chat_contacts_*/chat_groups_* caches. It survives
// app close/restart and logout->login on THIS device, but won't follow the
// account to a different device or a reinstall — the wallpaper "mode" value
// ('custom') is still synced, so other devices know to fall back to Default
// rather than silently showing nothing.
// ---------------------------------------------------------------------------

const customWallpaperKey = (userId) => `chat_wallpaper_custom_${userId}`;

export const getCustomWallpaper = (userId) => {
  if (!userId) return null;
  try {
    return localStorage.getItem(customWallpaperKey(userId));
  } catch (_) {
    return null;
  }
};

export const setCustomWallpaper = (userId, dataUrl) => {
  if (!userId) return;
  try {
    localStorage.setItem(customWallpaperKey(userId), dataUrl);
  } catch (e) {
    throw new Error('Image is too large to save. Try a smaller photo.');
  }
};

export const clearCustomWallpaper = (userId) => {
  if (!userId) return;
  try {
    localStorage.removeItem(customWallpaperKey(userId));
  } catch (_) { /* ignore */ }
};

// Downscales + JPEG-compresses an image file so it comfortably fits in
// localStorage (a few hundred KB at most) before it's handed to
// setCustomWallpaper(). Runs entirely client-side via <canvas>.
export const compressImageFile = (file, { maxDim = 1080, quality = 0.72 } = {}) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read that image.'));
    reader.onload = () => {
      const img = new window.Image();
      img.onerror = () => reject(new Error('Could not read that image.'));
      img.onload = () => {
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          const scale = maxDim / Math.max(width, height);
          width = Math.round(width * scale);
          height = Math.round(height * scale);
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });

// Applies (or clears) the custom wallpaper image as a CSS variable that
// index.css's [data-wallpaper="custom"] rule paints onto .chat-area only —
// never the rest of the app.
export const applyCustomWallpaperVar = (dataUrl) => {
  const root = document.documentElement;
  if (dataUrl) {
    root.style.setProperty('--wallpaper-image', `url("${dataUrl}")`);
  } else {
    root.style.removeProperty('--wallpaper-image');
  }
};

// ---------------------------------------------------------------------------
// Local-only settings
//
// Preferences with no meaningful "account" concept and no server enforcement
// need — purely cosmetic, device-scoped conveniences. Everything that
// actually changes server behavior (notifications) or is worth syncing
// across devices (theme, accent, font size, density, animations) lives in
// DEFAULT_USER_SETTINGS above instead.
// ---------------------------------------------------------------------------

export const DEFAULT_LOCAL_SETTINGS = Object.freeze({
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
  root.setAttribute('data-reduce-motion', settings.reduce_motion ? 'on' : 'off');
  root.setAttribute('data-high-contrast', settings.high_contrast ? 'on' : 'off');
  root.setAttribute('data-larger-text', settings.larger_text ? 'on' : 'off');
  root.setAttribute('data-timestamps', settings.message_timestamps || DEFAULT_LOCAL_SETTINGS.message_timestamps);
};