// ---------------------------------------------------------------------------
// Catch Me Up — summarization service
// ---------------------------------------------------------------------------
// This module is intentionally isolated from ChatDashboard's own state so it
// can be swapped for a real AI-powered backend endpoint later without
// touching any UI code. Every call site only depends on the exported
// function signatures below — not on how the summary is produced.
//
// TODO (backend): replace the body of `generateUnreadSummary` with a call to
// a real summarization endpoint, e.g.:
//   const res = await axios.post(`${API_URL}/catch-me-up/summarize`, {
//     chatId, isGroup, messages,
//   });
//   return res.data.summary;
// Keep the function `async` and returning a `string` so no caller needs to
// change when the real backend lands.
// ---------------------------------------------------------------------------

// Single source of truth for the "how many unread messages make a
// conversation eligible for Catch Me Up" rule, so the UI and any future
// backend stay in sync.
export const CATCH_UP_MIN_UNREAD = 3;

export const isEligibleForCatchUp = (unreadCount) => (unreadCount || 0) >= CATCH_UP_MIN_UNREAD;

const ACTION_HINTS = [
  'can you', 'could you', 'please', 'need to', 'need you', "let's", 'lets ',
  'reminder', 'deadline', 'don\'t forget', "dont forget", 'make sure',
  'asap', 'todo', 'to-do', 'follow up', 'follow-up', 'by tomorrow',
  'by today', 'due ', 'send me', 'send over',
];

const MEDIA_LABELS = {
  image: 'sent a photo',
  video: 'sent a video',
  audio: 'sent a voice message',
  gif: 'sent a GIF',
};

const truncate = (text, max = 140) => {
  const trimmed = (text || '').trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 3).trim()}...`;
};

const isQuestion = (text) => /\?\s*$/.test((text || '').trim());

const looksLikeActionItem = (text) => {
  const lower = (text || '').toLowerCase();
  return ACTION_HINTS.some((hint) => lower.includes(hint));
};

const describeMessage = (msg, isGroup) => {
  const senderLabel = isGroup ? (msg.sender_display_name || msg.sender_username || 'Someone') : null;
  if (msg.type && MEDIA_LABELS[msg.type] && !msg.content) {
    return { kind: 'media', text: MEDIA_LABELS[msg.type], senderLabel };
  }
  const content = (msg.content || '').trim();
  if (!content) return null;
  return { kind: 'text', text: content, senderLabel };
};

/**
 * Produces a concise, human-readable summary of a conversation's unread
 * messages. Only the messages passed in are considered — callers are
 * responsible for trimming the list down to just the unread tail.
 *
 * @param {Object} params
 * @param {string} params.chatName - Display name of the contact or group.
 * @param {boolean} params.isGroup - Whether this is a group conversation.
 * @param {Array} params.messages - The unread messages, oldest first.
 * @returns {Promise<string>} A short summary, ready to render as-is.
 */
export async function generateUnreadSummary({ chatName, isGroup, messages }) {
  const described = (messages || [])
    .map((m) => describeMessage(m, isGroup))
    .filter(Boolean);

  if (!described.length) {
    return `No readable content to summarize yet in ${chatName || 'this conversation'}.`;
  }

  const points = [];
  const questions = [];
  const actions = [];
  let mediaCount = 0;

  described.forEach((item) => {
    if (item.kind === 'media') {
      mediaCount += 1;
      return;
    }
    const prefix = item.senderLabel ? `${item.senderLabel}: ` : '';
    const line = truncate(`${prefix}${item.text}`);
    if (isQuestion(item.text)) questions.push(line);
    else if (looksLikeActionItem(item.text)) actions.push(line);
    else points.push(line);
  });

  const sections = [];
  if (points.length) {
    sections.push(['Key points', points.slice(0, 4)]);
  }
  if (questions.length) {
    sections.push(['Questions', questions.slice(0, 3)]);
  }
  if (actions.length) {
    sections.push(['Action items', actions.slice(0, 3)]);
  }

  if (!sections.length) {
    const mediaNote = mediaCount
      ? `mostly shared media (${mediaCount} item${mediaCount === 1 ? '' : 's'})`
      : 'nothing that looked actionable';
    return `${described.length} new message${described.length === 1 ? '' : 's'} — ${mediaNote}.`;
  }

  return sections
    .map(([title, lines]) => [`${title}:`, ...lines.map((l) => `• ${l}`)].join('\n'))
    .join('\n\n');
}