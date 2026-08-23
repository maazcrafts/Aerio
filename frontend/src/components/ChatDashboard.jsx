import React, { useState, useEffect, useRef, useCallback, lazy, Suspense } from 'react';
import axios from 'axios';
import { io } from 'socket.io-client';
import { Link } from 'react-router-dom';
import {
  Send, UserPlus, LogOut, Users, Image as ImageIcon, X, Check, CheckCircle, XCircle,
  ArrowLeft, Mic, MicOff, Reply as ReplyIcon, Play, Pause, Shield, Settings, Star, Pin,
  Search, Edit3, Trash2, Copy, Forward, Bell, Download, Lock, Sticker,
  Phone, PhoneOff, Video, VideoOff, SwitchCamera, Volume1, Volume2
} from 'lucide-react';
const EmojiPicker = lazy(() => import('emoji-picker-react'));
import { API_URL, SOCKET_URL, API_BASE_URL, TURN_ICE_SERVER } from '../config';
import ProfileModal from './ProfileModal';
import UserProfileModal from './UserProfileModal';
import GifPickerModal from './GifPickerModal';
import SettingsModal from './SettingsModal';
import StarredMessagesModal from './StarredMessagesModal';
import { applyAppearance, applyLocalAppearance, getLocalSettings } from '../utils/appearance';
import { registerPushNotifications, unregisterPushNotifications, consumePendingNotification } from '../push';
import { getOrCreateKeypair, getCachedPublicKeyBase64, publishPublicKey, fetchPublicKey, encryptForRecipient, decryptFromSender, resetE2eeState } from '../crypto';
import { ContactsSkeleton, MessagesSkeleton, ErrorState, NoInternetState, SlowNetworkState, NoResultsState } from './UIStates';
import { useNetworkStatus, useSlowRequestTimer } from '../hooks/useNetworkStatus';
let socket;

let currentlyPlayingAudioEl = null;
const registerPlayingAudio = (audioEl) => {
  if (currentlyPlayingAudioEl && currentlyPlayingAudioEl !== audioEl) {
    try { currentlyPlayingAudioEl.pause(); } catch (_) { }
  }
  currentlyPlayingAudioEl = audioEl;
};
const unregisterPlayingAudio = (audioEl) => {
  if (currentlyPlayingAudioEl === audioEl) currentlyPlayingAudioEl = null;
};

const AudioPlayer = ({ src, compact = false }) => {
  const audioRef = useRef(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [playbackRate, setPlaybackRate] = useState(1);
  const rafRef = useRef(null);
  const isSeekingRef = useRef(false);
  const rates = [1, 1.5, 2];
  const formatClock = (t) => {
    if (!Number.isFinite(t) || t <= 0) return '0:00';
    const m = Math.floor(t / 60);
    const s = Math.floor(t % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  };
  const stopRaf = () => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
  };
  const tick = () => {
    const a = audioRef.current;
    if (!a) return;
    if (!isSeekingRef.current) setCurrentTime(a.currentTime || 0);
    if (!a.paused) {
      rafRef.current = requestAnimationFrame(tick);
    } else {
      stopRaf();
    }
  };
  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    const fixInfiniteDurationIfNeeded = () => {
      if (a.duration === Infinity || Number.isNaN(a.duration)) {
        const onTimeUpdate = () => {
          a.removeEventListener('timeupdate', onTimeUpdate);
          const real = Number.isFinite(a.duration) ? a.duration : 0;
          setDuration(real);
          a.currentTime = 0;
          setCurrentTime(0);
        };
        a.addEventListener('timeupdate', onTimeUpdate);
        try { a.currentTime = 1e101; } catch (_) { }
      } else {
        setDuration(a.duration || 0);
      }
    };
    const onLoaded = () => {
      fixInfiniteDurationIfNeeded();
      if (!isSeekingRef.current) setCurrentTime(a.currentTime || 0);
    };
    const onDurationChange = () => {
      if (Number.isFinite(a.duration) && a.duration > 0) setDuration(a.duration);
    };
    const onEnded = () => {
      setIsPlaying(false);
      stopRaf();
      setCurrentTime(a.duration && Number.isFinite(a.duration) ? a.duration : 0);
      unregisterPlayingAudio(a);
    };
    const onPause = () => {
      setIsPlaying(false);
      stopRaf();
    };
    const onPlay = () => {
      setIsPlaying(true);
      registerPlayingAudio(a);
      stopRaf();
      rafRef.current = requestAnimationFrame(tick);
    };
    a.addEventListener('loadedmetadata', onLoaded);
    a.addEventListener('durationchange', onDurationChange);
    a.addEventListener('ended', onEnded);
    a.addEventListener('pause', onPause);
    a.addEventListener('play', onPlay);
    return () => {
      stopRaf();
      unregisterPlayingAudio(a);
      a.removeEventListener('loadedmetadata', onLoaded);
      a.removeEventListener('durationchange', onDurationChange);
      a.removeEventListener('ended', onEnded);
      a.removeEventListener('pause', onPause);
      a.removeEventListener('play', onPlay);
    };
  }, [src]);
  const togglePlay = async () => {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) {
      try {
        a.playbackRate = playbackRate;
        registerPlayingAudio(a);
        await a.play();
      } catch (_) { }
    } else {
      a.pause();
    }
  };
  const toggleSpeed = () => {
    const nextIdx = (rates.indexOf(playbackRate) + 1) % rates.length;
    const nextRate = rates[nextIdx];
    setPlaybackRate(nextRate);
    if (audioRef.current) {
      audioRef.current.playbackRate = nextRate;
    }
  };
  const onSeek = (value) => {
    const a = audioRef.current;
    if (!a || !Number.isFinite(duration) || duration <= 0) return;
    const next = Math.min(duration, Math.max(0, value));
    a.currentTime = next;
    setCurrentTime(next);
  };
  const beginSeek = () => { isSeekingRef.current = true; };
  const endSeek = () => { isSeekingRef.current = false; };
  const progress = duration > 0 ? Math.min(1, Math.max(0, currentTime / duration)) : 0;
  return (
    <div className={`audio-player ${compact ? 'compact' : ''}`}>
      <button type="button" className="audio-btn" onClick={togglePlay} aria-label={isPlaying ? 'Pause' : 'Play'}>
        {isPlaying ? <Pause size={16} /> : <Play size={16} />}
      </button>
      <div className="audio-mid">
        <div className="audio-waveform-bar">
          <div className="waveform-lines">
            {[40, 70, 30, 90, 50, 80, 60, 100, 40, 70, 90, 50, 30, 80].map((h, i) => (
              <span
                key={i}
                className={`wave-line ${i / 14 <= progress ? 'active' : ''}`}
                style={{ height: `${h}%` }}
              />
            ))}
          </div>
          <input
            className="audio-range"
            type="range"
            min={0}
            max={duration || 0}
            step={0.1}
            value={currentTime}
            onChange={(e) => onSeek(Number(e.target.value))}
            onMouseDown={beginSeek}
            onMouseUp={endSeek}
            onTouchStart={beginSeek}
            onTouchEnd={endSeek}
            disabled={!duration}
          />
        </div>
        <div className="audio-time">
          <span>{formatClock(currentTime)}</span>
          <span>/</span>
          <span>{formatClock(duration)}</span>
        </div>
      </div>
      <button type="button" className="speed-btn" onClick={toggleSpeed} title="Playback Speed">
        {playbackRate}x
      </button>
      <audio ref={audioRef} src={src || ''} preload="metadata" />
    </div>
  );
};

const CallOverlay = ({
  callState,
  callDismissing,
  activeCall,
  callDuration,
  isMuted,
  isCameraOff,
  isSpeakerOn,
  callError,
  onDismissError,
  localVideoRef,
  remoteVideoRef,
  remoteAudioRef,
  onAccept,
  onDecline,
  onEnd,
  onToggleMute,
  onToggleCamera,
  onToggleSpeaker,
  onSwitchCamera,
  normalizeMediaUrl
}) => {
  if (callState === 'idle') return null;

  const peer = activeCall?.peerInfo || {};
  const peerName = peer.display_name || peer.username || 'Unknown';
  const peerInitial = peerName ? peerName.charAt(0).toUpperCase() : '?';
  const isVideoCall = activeCall?.callType === 'video';
  const isLiveCall = callState === 'connecting' || callState === 'connected';

  const formatDuration = (secs) => {
    const m = Math.floor(secs / 60).toString().padStart(2, '0');
    const s = Math.floor(secs % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  };

  const Avatar = ({ size = 96, ring = false }) => (
    <div className={`call-avatar-wrap ${ring ? 'call-avatar-ring' : ''}`} style={{ width: size, height: size }}>
      {peer.avatar_url ? (
        <img src={normalizeMediaUrl(peer.avatar_url)} alt={peerName} className="call-avatar-img" />
      ) : (
        <div className="call-avatar-fallback" style={{ fontSize: size * 0.36 }}>{peerInitial}</div>
      )}
    </div>
  );

  const endStateCopy = {
    declined: 'Call declined',
    busy: `${peerName} is on another call`,
    offline: `${peerName} is offline`,
    ended: 'Call ended',
    failed: 'Call failed to connect',
    timeout: 'No answer'
  };

  const isEndState = ['declined', 'busy', 'offline', 'ended', 'failed', 'timeout'].includes(callState);

  return (
    <div className="call-overlay">
      {isLiveCall && (
        <>
          <video
            ref={remoteVideoRef}
            className={`call-remote-video ${isVideoCall && callState === 'connected' ? '' : 'call-remote-video-hidden'}`}
            autoPlay
            playsInline
            muted
          />
          <audio ref={remoteAudioRef} autoPlay playsInline style={{ display: 'none' }} />
        </>
      )}

      {callError && (
        <div className="call-error-banner">
          <span>{callError}</span>
          <button type="button" onClick={onDismissError} aria-label="Dismiss"><X size={14} /></button>
        </div>
      )}

      {callState === 'ringing' && (
        <div className="call-screen call-screen-incoming">
          <Avatar size={112} ring />
          <h2 className="call-peer-name">{peerName}</h2>
          <p className="call-status-text">Incoming {isVideoCall ? 'video' : 'voice'} call…</p>
          <div className="call-action-row">
            <button type="button" className="call-round-btn call-btn-decline" onClick={onDecline} aria-label="Decline">
              <PhoneOff size={26} />
            </button>
            <button type="button" className="call-round-btn call-btn-accept" onClick={onAccept} aria-label="Accept">
              {isVideoCall ? <Video size={26} /> : <Phone size={26} />}
            </button>
          </div>
        </div>
      )}

      {callState === 'calling' && (
        <div className="call-screen call-screen-outgoing">
          <Avatar size={112} ring />
          <h2 className="call-peer-name">{peerName}</h2>
          <p className="call-status-text">Calling…</p>
          <div className="call-action-row">
            <button type="button" className="call-round-btn call-btn-decline" onClick={onEnd} aria-label="Cancel">
              <PhoneOff size={26} />
            </button>
          </div>
        </div>
      )}

      {callState === 'connecting' && (
        <div className="call-screen call-screen-connecting">
          {isVideoCall && (
            <video
              ref={localVideoRef}
              className="call-local-preview-video"
              autoPlay
              playsInline
              muted
            />
          )}
          <Avatar size={112} ring />
          <h2 className="call-peer-name">{peerName}</h2>
          <p className="call-status-text">Connecting…</p>
          <div className="call-action-row">
            <button type="button" className="call-round-btn call-btn-decline" onClick={onEnd} aria-label="Cancel">
              <PhoneOff size={26} />
            </button>
          </div>
        </div>
      )}

      {callState === 'connected' && (
        <div className={`call-screen call-screen-connected ${isVideoCall ? 'is-video' : 'is-voice'}`}>
          {isVideoCall ? (
            <>
              <div className="call-local-preview">
                <video ref={localVideoRef} className="call-local-preview-video" autoPlay playsInline muted />
                {isCameraOff && (
                  <div className="call-local-preview-off">
                    <VideoOff size={18} />
                  </div>
                )}
              </div>
              <div className="call-top-bar">
                <span className="call-duration-pill">{formatDuration(callDuration)}</span>
              </div>
            </>
          ) : (
            <>
              <Avatar size={132} ring />
              <h2 className="call-peer-name">{peerName}</h2>
              <p className="call-status-text call-duration-text">{formatDuration(callDuration)}</p>
              <video ref={localVideoRef} autoPlay playsInline muted style={{ display: 'none' }} />
            </>
          )}

          <div className="call-controls-row">
            <button
              type="button"
              className={`call-round-btn call-btn-secondary ${isMuted ? 'active' : ''}`}
              onClick={onToggleMute}
              aria-label={isMuted ? 'Unmute' : 'Mute'}
              title={isMuted ? 'Unmute' : 'Mute'}
            >
              {isMuted ? <MicOff size={22} /> : <Mic size={22} />}
            </button>

            <button
              type="button"
              className={`call-round-btn call-btn-secondary ${isSpeakerOn ? 'active' : ''}`}
              onClick={onToggleSpeaker}
              aria-label={isSpeakerOn ? 'Turn speaker off' : 'Turn speaker on'}
              title={isSpeakerOn ? 'Turn speaker off' : 'Turn speaker on'}
            >
              {isSpeakerOn ? <Volume2 size={22} /> : <Volume1 size={22} />}
            </button>

            {isVideoCall && (
              <button
                type="button"
                className={`call-round-btn call-btn-secondary ${isCameraOff ? 'active' : ''}`}
                onClick={onToggleCamera}
                aria-label={isCameraOff ? 'Turn camera on' : 'Turn camera off'}
                title={isCameraOff ? 'Turn camera on' : 'Turn camera off'}
              >
                {isCameraOff ? <VideoOff size={22} /> : <Video size={22} />}
              </button>
            )}

            {isVideoCall && (
              <button
                type="button"
                className="call-round-btn call-btn-secondary"
                onClick={onSwitchCamera}
                aria-label="Switch camera"
                title="Switch camera"
              >
                <SwitchCamera size={22} />
              </button>
            )}

            <button type="button" className="call-round-btn call-btn-decline" onClick={onEnd} aria-label="End call">
              <PhoneOff size={22} />
            </button>
          </div>
        </div>
      )}

      {isEndState && (
        <div className={`call-screen call-screen-ended ${callDismissing ? 'is-dismissing' : ''}`}>
          <Avatar size={88} />
          <h2 className="call-peer-name">{peerName}</h2>
          <p className="call-status-text">{endStateCopy[callState] || 'Call ended'}</p>
        </div>
      )}
    </div>
  );
};

const GroupRow = React.memo(function GroupRow({ group, isActive, unread, onSelect, normalizeMediaUrl }) {
  return (
    <div
      className={`contact-item ${isActive ? 'active' : ''}`}
      onClick={() => onSelect(group)}
    >
      {group.avatar_url ? (
        <img src={normalizeMediaUrl(group.avatar_url)} alt="Group" className="circular-avatar" style={{ width: 38, height: 38 }} />
      ) : (
        <div className="avatar group"><Users size={18} /></div>
      )}
      <div className="contact-info">
        <h4>{group.name}</h4>
        <span className="contact-subtitle">{group.description || 'Group Chat'}</span>
      </div>
      {unread > 0 && <div className="unread-badge">{unread}</div>}
    </div>
  );
});

const ContactRow = React.memo(function ContactRow({ contact, isActive, unread, isTyping, isOnline, onSelect, normalizeMediaUrl }) {
  return (
    <div
      className={`contact-item ${isActive ? 'active' : ''}`}
      onClick={() => onSelect(contact)}
    >
      <span className="avatar-wrapper">
        {contact.avatar_url ? (
          <img src={normalizeMediaUrl(contact.avatar_url)} alt="Avatar" className="circular-avatar" style={{ width: 38, height: 38 }} />
        ) : (
          <div className="avatar">{(contact.username || contact.display_name || '?').charAt(0).toUpperCase()}</div>
        )}
        {isOnline && <span className="online-status-dot" />}
      </span>
      <div className="contact-info">
        <h4>{contact.display_name || contact.username}</h4>
        <span className="contact-subtitle">
          {isTyping ? <span style={{ color: '#10b981', fontWeight: 600 }}>typing...</span> : (contact.bio || `@${contact.username}`)}
        </span>
      </div>
      {unread > 0 && <div className="unread-badge">{unread}</div>}
    </div>
  );
});

const ChatDashboard = ({ user, setUser, userSettings, settingsLoading, onSettingsSaved }) => {
  const [contacts, setContacts] = useState([]);
  const [onlineUserIds, setOnlineUserIds] = useState(() => new Set());
  const [groups, setGroups] = useState([]);
  const [friendRequests, setFriendRequests] = useState([]);
  const [activeChat, setActiveChat] = useState(null);
  const [activeChatEncrypted, setActiveChatEncrypted] = useState(false);
  const [messages, setMessages] = useState([]);

  // ── UI states: loading / error / offline / slow-network ──────────────
  const isOnline = useNetworkStatus();
  const [initialLoading, setInitialLoading] = useState(true);
  const [initialLoadError, setInitialLoadError] = useState(false);
  const [initialLoadSlow, setInitialLoadSlow] = useState(false);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [messagesLoadError, setMessagesLoadError] = useState(false);
  const [messagesLoadSlow, setMessagesLoadSlow] = useState(false);
  const hadCachedDataRef = useRef(false);
  const initialSlowTimer = useSlowRequestTimer(setInitialLoadSlow);
  const messagesSlowTimer = useSlowRequestTimer(setMessagesLoadSlow);
  const [newMessage, setNewMessage] = useState('');
  const [addFriendUsername, setAddFriendUsername] = useState('');
  const [userSearchResults, setUserSearchResults] = useState([]);

  const decryptIncomingMessage = async (msgObj) => {
    if (msgObj.group_id || !msgObj.ciphertext || !msgObj.nonce) return msgObj;
    const otherPartyId = Number(msgObj.sender_id) === Number(user.id) ? msgObj.receiver_id : msgObj.sender_id;
    const otherPartyKey = await fetchPublicKey(otherPartyId, user.token);
    if (!otherPartyKey) return { ...msgObj, content: '[Unable to decrypt — key unavailable]' };
    const plaintext = await decryptFromSender(msgObj.ciphertext, msgObj.nonce, otherPartyKey, user.id);
    return { ...msgObj, content: plaintext !== null ? plaintext : '[Unable to decrypt this message]' };
  };

  const bumpContactToTop = (id) => {
    setContacts(prev => {
      const idx = prev.findIndex(c => Number(c.id) === Number(id));
      if (idx <= 0) return prev;
      const next = prev.slice();
      const [item] = next.splice(idx, 1);
      next.unshift(item);
      return next;
    });
  };

  const bumpGroupToTop = (id) => {
    setGroups(prev => {
      const idx = prev.findIndex(g => Number(g.id) === Number(id));
      if (idx === -1) return prev;
      const item = prev[idx];
      const rest = prev.slice(0, idx).concat(prev.slice(idx + 1));
      const isAnnouncements = String(item.name || '').toLowerCase() === 'announcements';
      if (isAnnouncements) return [item, ...rest];
      const pinnedFirst = String(rest[0]?.name || '').toLowerCase() === 'announcements';
      return pinnedFirst ? [rest[0], item, ...rest.slice(1)] : [item, ...rest];
    });
  };

  const [isSearchingUsers, setIsSearchingUsers] = useState(false);
  const [sentFriendRequests, setSentFriendRequests] = useState({});
  const [showProfileModal, setShowProfileModal] = useState(false);
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [profileModalAutoPassword, setProfileModalAutoPassword] = useState(false);
  const [showStarredModal, setShowStarredModal] = useState(false);
  const [showGroupModal, setShowGroupModal] = useState(false);
  const [showFriendRequestsModal, setShowFriendRequestsModal] = useState(false);
  const [showGroupDetailsModal, setShowGroupDetailsModal] = useState(false);
  const [viewingUserId, setViewingUserId] = useState(null);
  const [newGroupName, setNewGroupName] = useState('');
  const [newGroupDesc, setNewGroupDesc] = useState('');
  const [selectedContacts, setSelectedContacts] = useState([]);
  const [groupMembers, setGroupMembers] = useState([]);
  const [groupEditName, setGroupEditName] = useState('');
  const [groupEditDesc, setGroupEditDesc] = useState('');
  const [groupDetailsBusy, setGroupDetailsBusy] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [showSearch, setShowSearch] = useState(false);
  const [pinnedMessages, setPinnedMessages] = useState([]);
  const [typingUsers, setTypingUsers] = useState({});
  const typingTimeoutRef = useRef(null);
  const [editingMessage, setEditingMessage] = useState(null);
  const [editContent, setEditContent] = useState('');
  const [forwardingMessage, setForwardingMessage] = useState(null);
  const [isRecording, setIsRecording] = useState(false);
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const recordingTimerRef = useRef(null);
  const [recordedAudioBlob, setRecordedAudioBlob] = useState(null);
  const [recordedAudioUrl, setRecordedAudioUrl] = useState(null);
  const recordedAudioUrlRef = useRef(null);
  const [unreadCounts, setUnreadCounts] = useState({});
  const activeChatRef = useRef(null);
  const notificationSoundsRef = useRef(userSettings.notification_sounds);
  const localSettingsRef = useRef(getLocalSettings(user?.id));
  const messagesEndRef = useRef(null);
  const messagesContainerRef = useRef(null);
  const fileInputRef = useRef(null);
  const messageInputRef = useRef(null);
  const isAtBottomRef = useRef(true);
  const [lightboxUrl, setLightboxUrl] = useState(null);
  const [pendingImage, setPendingImage] = useState(null);
  const [pendingVideo, setPendingVideo] = useState(null);
  const [viewOnceViewer, setViewOnceViewer] = useState(null);
  const viewOnceTimerRef = useRef(null);
  const [viewOnceOpeningId, setViewOnceOpeningId] = useState(null);
  const [callState, setCallState] = useState('idle');
  const [activeCall, setActiveCall] = useState(null);
  const [callDuration, setCallDuration] = useState(0);
  const [isMuted, setIsMuted] = useState(false);
  const [isCameraOff, setIsCameraOff] = useState(false);
  const [isSpeakerOn, setIsSpeakerOn] = useState(false);
  const [facingMode, setFacingMode] = useState('user');
  const [callError, setCallError] = useState('');
  const [remoteStreamVersion, setRemoteStreamVersion] = useState(0);
  const [localStreamVersion, setLocalStreamVersion] = useState(0);
  const [callDismissing, setCallDismissing] = useState(false);

  const peerConnectionRef = useRef(null);
  const localStreamRef = useRef(null);
  const remoteStreamRef = useRef(null);
  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);
  const remoteAudioRef = useRef(null);
  const callDurationTimerRef = useRef(null);
  const autoDismissTimersRef = useRef({ fade: null, idle: null });
  const pendingIceCandidatesRef = useRef([]);
  const hasConnectedOnceRef = useRef(false);
  const activeCallRef = useRef(null);
  const callStateRef = useRef('idle');
  const callRoleRef = useRef(null);
  const lastCallInfoRef = useRef(null);

  useEffect(() => { activeCallRef.current = activeCall; }, [activeCall]);
  useEffect(() => { callStateRef.current = callState; }, [callState]);
  useEffect(() => { if (activeCall) lastCallInfoRef.current = activeCall; }, [activeCall]);

  const RTC_CONFIG = {
    iceServers: [
      { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
      ...(TURN_ICE_SERVER ? [TURN_ICE_SERVER] : [])
    ],
    iceCandidatePoolSize: 4
  };

  const CALL_CONNECT_TIMEOUT_MS = 20000;
  const connectingWatchdogRef = useRef(null);
  useEffect(() => {
    if (callState === 'connecting') {
      connectingWatchdogRef.current = setTimeout(() => {
        if (callStateRef.current !== 'connecting') return;
        const call = activeCallRef.current;
        if (call && socket) socket.emit('call:end', { callId: call.callId });
        setCallError('Could not establish a connection. This can happen on restrictive networks.');
        resetCallState();
        setCallState('failed');
        scheduleAutoDismiss('failed');
      }, CALL_CONNECT_TIMEOUT_MS);
    }
    return () => {
      if (connectingWatchdogRef.current) { clearTimeout(connectingWatchdogRef.current); connectingWatchdogRef.current = null; }
    };
  }, [callState]);

  const cleanupCallResources = () => {
    const pc = peerConnectionRef.current;
    if (pc) {
      pc.ontrack = null;
      pc.onicecandidate = null;
      pc.onconnectionstatechange = null;
      pc.oniceconnectionstatechange = null;
      try { pc.getSenders().forEach(s => { try { s.track && s.track.stop(); } catch (_) { } }); } catch (_) { }
      try { pc.close(); } catch (_) { }
      peerConnectionRef.current = null;
    }
    if (localStreamRef.current) {
      try { localStreamRef.current.getTracks().forEach(t => t.stop()); } catch (_) { }
      localStreamRef.current = null;
    }
    remoteStreamRef.current = null;
    if (localVideoRef.current) localVideoRef.current.srcObject = null;
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
    if (remoteAudioRef.current) remoteAudioRef.current.srcObject = null;
    if (callDurationTimerRef.current) { clearInterval(callDurationTimerRef.current); callDurationTimerRef.current = null; }
    if (autoDismissTimersRef.current.fade) { clearTimeout(autoDismissTimersRef.current.fade); autoDismissTimersRef.current.fade = null; }
    if (autoDismissTimersRef.current.idle) { clearTimeout(autoDismissTimersRef.current.idle); autoDismissTimersRef.current.idle = null; }
    setCallDismissing(false);
    pendingIceCandidatesRef.current = [];
    callRoleRef.current = null;
  };

  const scheduleAutoDismiss = (state) => {
    if (autoDismissTimersRef.current.fade) clearTimeout(autoDismissTimersRef.current.fade);
    if (autoDismissTimersRef.current.idle) clearTimeout(autoDismissTimersRef.current.idle);
    setCallDismissing(false);
    autoDismissTimersRef.current.fade = setTimeout(() => setCallDismissing(true), 1400);
    autoDismissTimersRef.current.idle = setTimeout(() => {
      setCallState(prev => (prev === state ? 'idle' : prev));
      setCallDismissing(false);
    }, 2000);
  };

  const resetCallState = () => {
    cleanupCallResources();
    setActiveCall(null);
    setCallDuration(0);
    setIsMuted(false);
    setIsCameraOff(false);
    setIsSpeakerOn(false);
    setFacingMode('user');
  };

  const getMediaConstraints = (callType) => ({
    audio: true,
    video: callType === 'video' ? { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } } : false
  });

  const createPeerConnection = (callId, peerUserId) => {
    const pc = new RTCPeerConnection(RTC_CONFIG);
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(track => {
        pc.addTrack(track, localStreamRef.current);
      });
    }
    pc.onicecandidate = (e) => {
      if (e.candidate && socket) {
        socket.emit('call:ice-candidate', { callId, candidate: e.candidate });
      }
    };
    pc.ontrack = (e) => {
      if (!remoteStreamRef.current) remoteStreamRef.current = new MediaStream();
      remoteStreamRef.current.addTrack(e.track);
      setRemoteStreamVersion(v => v + 1);
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') {
        if (socket) socket.emit('call:connected', { callId });
        setCallState('connected');
      } else if (pc.connectionState === 'failed') {
        setCallState('failed');
        resetCallState();
      }
    };
    peerConnectionRef.current = pc;
    return pc;
  };

  useEffect(() => {
    const stream = remoteStreamRef.current;
    if (remoteAudioRef.current && remoteAudioRef.current.srcObject !== stream) {
      remoteAudioRef.current.srcObject = stream || null;
      if (stream) remoteAudioRef.current.play?.().catch(() => { });
    }
    if (remoteVideoRef.current && remoteVideoRef.current.srcObject !== stream) {
      remoteVideoRef.current.srcObject = stream || null;
      if (stream) remoteVideoRef.current.play?.().catch(() => { });
    }
    if (remoteAudioRef.current) applySpeakerRouting(isSpeakerOn);
  }, [remoteStreamVersion, callState, isSpeakerOn]);

  useEffect(() => {
    const stream = localStreamRef.current;
    if (localVideoRef.current && stream && localVideoRef.current.srcObject !== stream) {
      localVideoRef.current.srcObject = stream;
      localVideoRef.current.play?.().catch(() => { });
    }
  }, [localStreamVersion, callState]);

  const applySpeakerRouting = async (speakerOn) => {
    const audioEl = remoteAudioRef.current;
    if (!audioEl) return;
    audioEl.volume = speakerOn ? 1.0 : 0.35;
    if (typeof audioEl.setSinkId === 'function' && navigator.mediaDevices?.enumerateDevices) {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const outputs = devices.filter(d => d.kind === 'audiooutput');
        const pattern = speakerOn ? /speaker/i : /ear.?piece|receiver/i;
        const match = outputs.find(d => pattern.test(d.label));
        if (match) await audioEl.setSinkId(match.deviceId);
        else if (speakerOn) await audioEl.setSinkId('');
      } catch (_) { }
    }
  };

  const toggleSpeaker = () => {
    const next = !isSpeakerOn;
    setIsSpeakerOn(next);
    applySpeakerRouting(next);
  };

  const flushPendingIceCandidates = async () => {
    const pc = peerConnectionRef.current;
    if (!pc || !pc.remoteDescription) return;
    const queued = pendingIceCandidatesRef.current;
    pendingIceCandidatesRef.current = [];
    for (const candidate of queued) {
      try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch (_) { }
    }
  };

  const startCall = async (targetUser, callType) => {
    if (callState !== 'idle' || !targetUser?.id) return;
    setCallError('');
    setCallState('calling');
    setActiveCall({ callId: null, callType, peerUserId: targetUser.id, peerInfo: targetUser, direction: 'outgoing' });
    callRoleRef.current = 'caller';
    try {
      localStreamRef.current = await navigator.mediaDevices.getUserMedia(getMediaConstraints(callType));
      if (localVideoRef.current) localVideoRef.current.srcObject = localStreamRef.current;
      setLocalStreamVersion(v => v + 1);
    } catch (err) {
      setCallError(err?.name === 'NotAllowedError'
        ? `${callType === 'video' ? 'Camera/microphone' : 'Microphone'} permission was denied.`
        : 'Could not access microphone/camera.');
      resetCallState();
      setCallState('failed');
      scheduleAutoDismiss('failed');
      return;
    }
    if (!socket) {
      setCallError('Not connected. Please check your connection and try again.');
      resetCallState();
      setCallState('failed');
      scheduleAutoDismiss('failed');
      return;
    }
    socket.emit('call:invite', { targetUserId: targetUser.id, callType });
  };

  const acceptCall = async () => {
    const call = activeCallRef.current;
    if (!call || callState !== 'ringing') return;
    callRoleRef.current = 'callee';
    setCallState('connecting');
    try {
      localStreamRef.current = await navigator.mediaDevices.getUserMedia(getMediaConstraints(call.callType));
      if (localVideoRef.current) localVideoRef.current.srcObject = localStreamRef.current;
      setLocalStreamVersion(v => v + 1);
    } catch (err) {
      setCallError(err?.name === 'NotAllowedError'
        ? `${call.callType === 'video' ? 'Camera/microphone' : 'Microphone'} permission was denied.`
        : 'Could not access microphone/camera.');
      if (socket) socket.emit('call:decline', { callId: call.callId });
      resetCallState();
      setCallState('failed');
      scheduleAutoDismiss('failed');
      return;
    }
    if (socket) socket.emit('call:accept', { callId: call.callId });
  };

  const declineCall = () => {
    const call = activeCallRef.current;
    if (call && socket) socket.emit('call:decline', { callId: call.callId });
    resetCallState();
    setCallState('idle');
  };

  const endCall = () => {
    const call = activeCallRef.current;
    if (call && socket) socket.emit('call:end', { callId: call.callId });
    resetCallState();
    setCallState('idle');
  };

  const toggleMute = () => {
    if (!localStreamRef.current) return;
    const nextMuted = !isMuted;
    localStreamRef.current.getAudioTracks().forEach(t => { t.enabled = !nextMuted; });
    setIsMuted(nextMuted);
  };

  const toggleCamera = () => {
    if (!localStreamRef.current) return;
    const nextOff = !isCameraOff;
    localStreamRef.current.getVideoTracks().forEach(t => { t.enabled = !nextOff; });
    setIsCameraOff(nextOff);
  };

  const switchCamera = async () => {
    if (!localStreamRef.current || activeCall?.callType !== 'video') return;
    const nextFacingMode = facingMode === 'user' ? 'environment' : 'user';
    let newStream;
    try {
      newStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { exact: nextFacingMode }, width: { ideal: 640 }, height: { ideal: 480 } }
      });
    } catch (_) {
      try {
        newStream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: nextFacingMode, width: { ideal: 640 }, height: { ideal: 480 } }
        });
      } catch (err) {
        setCallError('Could not switch camera.');
        return;
      }
    }
    const newVideoTrack = newStream.getVideoTracks()[0];
    if (!newVideoTrack) return;
    newVideoTrack.enabled = !isCameraOff;
    const pc = peerConnectionRef.current;
    if (pc) {
      const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
      if (sender) {
        try { await sender.replaceTrack(newVideoTrack); } catch (_) { }
      }
    }
    const oldVideoTrack = localStreamRef.current.getVideoTracks()[0];
    if (oldVideoTrack) {
      localStreamRef.current.removeTrack(oldVideoTrack);
      try { oldVideoTrack.stop(); } catch (_) { }
    }
    localStreamRef.current.addTrack(newVideoTrack);
    setFacingMode(nextFacingMode);
    setLocalStreamVersion(v => v + 1);
  };

  useEffect(() => {
    if (callState === 'connected') {
      const startedAt = Date.now();
      callDurationTimerRef.current = setInterval(() => {
        setCallDuration(Math.floor((Date.now() - startedAt) / 1000));
      }, 1000);
    }
    return () => {
      if (callDurationTimerRef.current) { clearInterval(callDurationTimerRef.current); callDurationTimerRef.current = null; }
    };
  }, [callState]);

  useEffect(() => {
    const isCallActive = callState !== 'idle';
    document.body.classList.toggle('call-active-lock', isCallActive);
    return () => { document.body.classList.remove('call-active-lock'); };
  }, [callState]);

  const wakeLockRef = useRef(null);
  useEffect(() => {
    let cancelled = false;
    const releaseWakeLock = async () => {
      if (wakeLockRef.current) {
        try { await wakeLockRef.current.release(); } catch (_) { }
        wakeLockRef.current = null;
      }
    };
    const acquireWakeLock = async () => {
      if (!('wakeLock' in navigator)) return;
      try {
        const lock = await navigator.wakeLock.request('screen');
        if (cancelled) { try { await lock.release(); } catch (_) { } return; }
        wakeLockRef.current = lock;
      } catch (_) { }
    };
    if (callState === 'connected') {
      acquireWakeLock();
    } else {
      releaseWakeLock();
    }
    return () => { cancelled = true; releaseWakeLock(); };
  }, [callState]);

  useEffect(() => {
    const onVisibilityChange = async () => {
      if (document.visibilityState === 'visible' && callStateRef.current === 'connected' && !wakeLockRef.current && 'wakeLock' in navigator) {
        try { wakeLockRef.current = await navigator.wakeLock.request('screen'); } catch (_) { }
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, []);

  const [showGifPicker, setShowGifPicker] = useState(false);
  const [replyTo, setReplyTo] = useState(null);
  const [messageMenu, setMessageMenu] = useState(null);
  const [selectedMessageId, setSelectedMessageId] = useState(null);
  const longPressTimerRef = useRef(null);
  const messageMenuRef = useRef(null);
  const [emojiPickerFor, setEmojiPickerFor] = useState(null);
  const [emojiPickerAnchor, setEmojiPickerAnchor] = useState(null);
  const [quickReactionFor, setQuickReactionFor] = useState(null);
  const [quickReactionAnchor, setQuickReactionAnchor] = useState(null);
  const emojiPickerHoverRef = useRef(false);

  const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '😡'];

  const normalizeMediaUrl = useCallback((url) => {
    if (!url) return '';
    if (url.startsWith('http://') || url.startsWith('https://')) return url;
    return `${API_BASE_URL}${url.startsWith('/') ? '' : '/'}${url}`;
  }, []);

  useEffect(() => {
    notificationSoundsRef.current = userSettings.notification_sounds;
    applyAppearance(userSettings);
  }, [userSettings]);

  useEffect(() => {
    const local = getLocalSettings(user?.id);
    localSettingsRef.current = local;
    applyLocalAppearance(local);
  }, [user?.id]);

  useEffect(() => {
    if (!showSettingsModal) {
      const local = getLocalSettings(user?.id);
      localSettingsRef.current = local;
      applyLocalAppearance(local);
    }
  }, [showSettingsModal, user?.id]);

  useEffect(() => {
    activeChatRef.current = activeChat;
    if (activeChat) {
      setUnreadCounts(prev => {
        const key = activeChat.is_group ? `group_${activeChat.id}` : `user_${activeChat.id}`;
        if (!prev[key]) return prev;
        const newCounts = { ...prev };
        delete newCounts[key];
        return newCounts;
      });
      fetchPinnedMessages(activeChat);
    }
    if (socket && socket.connected) {
      socket.emit('active_chat', activeChat ? { isGroup: !!activeChat.is_group, targetId: activeChat.id } : {});
    }
  }, [activeChat]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!activeChat || activeChat.is_group) {
        if (!cancelled) setActiveChatEncrypted(false);
        return;
      }
      const [myKey, theirKey] = await Promise.all([
        getOrCreateKeypair(user.id).then(() => getCachedPublicKeyBase64()),
        fetchPublicKey(activeChat.id, user.token),
      ]);
      if (!cancelled) setActiveChatEncrypted(!!myKey && !!theirKey);
    })();
    return () => { cancelled = true; };
  }, [activeChat]);

  useEffect(() => {
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      Notification.requestPermission();
    }
    try {
      const cachedContacts = localStorage.getItem(`chat_contacts_${user.id}`);
      const cachedGroups = localStorage.getItem(`chat_groups_${user.id}`);
      if (cachedContacts) setContacts(JSON.parse(cachedContacts));
      if (cachedGroups) setGroups(JSON.parse(cachedGroups));
      hadCachedDataRef.current = !!(cachedContacts || cachedGroups);
    } catch (_) { }

    let cancelled = false;

    const bootstrap = async () => {
      if (cancelled) return;
      const groupsData = await loadInitialData();

      try {
        if (user?.openAnnouncement && user.openAnnouncement.groupId) {
          const gid = Number(user.openAnnouncement.groupId);
          const clearOpenAnnouncementFlag = () => {
            setUser(prev => {
              if (!prev || !prev.openAnnouncement) return prev;
              const next = { ...prev, openAnnouncement: null };
              try { localStorage.setItem('chat_user', JSON.stringify(next)); } catch (_) { }
              return next;
            });
          };
          if (!activeChatRef.current) {
            const g = (groupsData || groups).find(gr => Number(gr.id) === gid);
            if (g) {
              setActiveChat({ ...g, is_group: true });
            } else {
              const refreshed = await fetchGroups();
              const g2 = (refreshed || groups).find(gr => Number(gr.id) === gid);
              if (g2 && !activeChatRef.current) setActiveChat({ ...g2, is_group: true });
            }
          }
          clearOpenAnnouncementFlag();
        }
      } catch (e) {
        console.error('Failed to open announcements group on login:', e && e.message ? e.message : e);
      }

      try {
        const pending = consumePendingNotification();
        if (pending && !activeChatRef.current) {
          await openConversationFromNotification(pending);
        }
      } catch (e) {
        console.error('Failed to open conversation from pending notification:', e && e.message ? e.message : e);
      }
    };

    bootstrap();

    registerPushNotifications({ onNotificationTap: openConversationFromNotification });

    (async () => {
      try {
        await getOrCreateKeypair(user.id);
        await publishPublicKey(user.token, user.id);
      } catch (e) {
        console.error('[e2ee] Failed to set up encryption keys:', e && e.message ? e.message : e);
      }
    })();

    socket = io(SOCKET_URL, { auth: { token: user.token } });

    socket.on('connect', () => {
      socket.emit('join');
      if (activeChatRef.current) {
        socket.emit('active_chat', { isGroup: !!activeChatRef.current.is_group, targetId: activeChatRef.current.id });
      }
      if (hasConnectedOnceRef.current && callStateRef.current !== 'idle') {
        setCallError('Connection was lost during the call.');
        resetCallState();
        setCallState('failed');
        scheduleAutoDismiss('failed');
      }
      hasConnectedOnceRef.current = true;
    });

    socket.on('receive_message', async (msgObjRaw) => {
      const msgObj = await decryptIncomingMessage(msgObjRaw);
      if (msgObj.group_id) {
        bumpGroupToTop(msgObj.group_id);
      } else {
        bumpContactToTop(msgObj.sender_id);
      }
      const isCurrentChat = activeChatRef.current && (
        (msgObj.group_id && activeChatRef.current.is_group && Number(activeChatRef.current.id) === Number(msgObj.group_id)) ||
        (!msgObj.group_id && !activeChatRef.current?.is_group &&
          (Number(activeChatRef.current.id) === Number(msgObj.sender_id) || Number(activeChatRef.current.id) === Number(msgObj.receiver_id)))
      );
      if (isCurrentChat) {
        setMessages((prev) => {
          if (msgObj.id && prev.some(m => Number(m.id) === Number(msgObj.id))) return prev;
          return [...prev, msgObj];
        });
        if (!msgObj.group_id && socket) {
          socket.emit('mark_read', { userId: user.id, friendId: msgObj.sender_id });
        }
      } else {
        const local = localSettingsRef.current;
        const isGroupMsg = !!msgObj.group_id;
        const notifyAllowed = isGroupMsg ? local.group_notifications !== false : local.message_notifications !== false;
        const title = isGroupMsg ? `New message in Group` : `New message from ${msgObj.sender_username || 'Friend'}`;
        const previewBody = msgObj.type === 'image' ? '[Image]' : (msgObj.type === 'audio' ? '[Voice Message]' : (msgObj.type === 'video' ? '[Video]' : msgObj.content));
        if (notifyAllowed && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
          new Notification(title, {
            body: local.notification_preview === 'hide' ? 'New message' : previewBody,
            silent: !notificationSoundsRef.current,
          });
        }
        if (notifyAllowed && local.vibration !== false && typeof navigator !== 'undefined' && navigator.vibrate) {
          navigator.vibrate(200);
        }
        const key = msgObj.group_id ? `group_${msgObj.group_id}` : `user_${msgObj.sender_id}`;
        setUnreadCounts(prev => ({ ...prev, [key]: (prev[key] || 0) + 1 }));
      }
    });

    socket.on('message_sent', async (msgObjRaw) => {
      const msgObj = await decryptIncomingMessage(msgObjRaw);
      if (msgObj.group_id) {
        bumpGroupToTop(msgObj.group_id);
      } else {
        bumpContactToTop(msgObj.receiver_id);
      }
      if (!msgObj.group_id && activeChatRef.current && !activeChatRef.current.is_group && Number(activeChatRef.current.id) === Number(msgObj.receiver_id)) {
        setMessages((prev) => {
          if (msgObj.id && prev.some(m => Number(m.id) === Number(msgObj.id))) return prev;
          return [...prev, msgObj];
        });
      }
    });

    socket.on('message_delivered', (payload) => {
      const messageId = payload?.messageId;
      if (!messageId) return;
      setMessages(prev => prev.map(m => (Number(m.id) === Number(messageId) ? { ...m, status: 'delivered' } : m)));
    });

    socket.on('user_typing', (payload) => {
      const senderId = payload?.senderId;
      if (!senderId) return;
      setTypingUsers(prev => ({ ...prev, [senderId]: true }));
    });

    socket.on('user_stop_typing', (payload) => {
      const senderId = payload?.senderId;
      if (!senderId) return;
      setTypingUsers(prev => ({ ...prev, [senderId]: false }));
    });

    socket.on('message_edited', (payload) => {
      const messageId = payload?.messageId;
      if (!messageId) return;
      setMessages(prev => prev.map(m => (Number(m.id) === Number(messageId) ? { ...m, content: payload.content, edited: true } : m)));
    });

    socket.on('message_deleted', (payload) => {
      const messageId = payload?.messageId;
      if (!messageId) return;
      setMessages(prev => prev.map(m => (Number(m.id) === Number(messageId) ? { ...m, content: 'This message was deleted', deleted_for_everyone: true, image_url: null } : m)));
    });

    socket.on('pin_updated', () => {
      if (activeChatRef.current) fetchPinnedMessages(activeChatRef.current);
    });

    socket.on('new_friend_request', () => {
      fetchRequests();
      const local = localSettingsRef.current;
      if (local.friend_request_notifications !== false && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        new Notification('New friend request', {
          body: local.notification_preview === 'hide' ? 'You have a new friend request' : 'Someone sent you a friend request',
          silent: !notificationSoundsRef.current,
        });
        if (local.vibration !== false && typeof navigator !== 'undefined' && navigator.vibrate) navigator.vibrate(200);
      }
    });
    socket.on('friend_request_accepted', () => { fetchContacts(); });
    socket.on('user_status', (payload = {}) => {
      const uid = Number(payload.userId);
      if (!uid) return;
      setOnlineUserIds(prev => {
        const next = new Set(prev);
        if (payload.online) next.add(uid);
        else next.delete(uid);
        return next;
      });
    });
    socket.on('messages_read', (data) => {
      const byUserId = data?.by_user_id;
      if (!byUserId) return;
      setMessages((prev) => prev.map(m => {
        if (m.group_id) return m;
        if (Number(m.sender_id) === Number(user.id) && Number(m.receiver_id) === Number(byUserId)) {
          return { ...m, status: 'seen' };
        }
        return m;
      }));
    });

    socket.on('reaction_updated', (payload) => {
      const messageId = payload?.messageId;
      if (!messageId) return;
      setMessages(prev => prev.map(m => (Number(m.id) === Number(messageId) ? { ...m, reactions: payload.reactions || [] } : m)));
    });

    socket.on('added_to_group', (payload) => {
      const groupId = payload?.groupId;
      const group = payload?.group;
      if (socket && groupId) socket.emit('join_new_group', groupId);
      if (group) {
        setGroups(prev => {
          if (prev.some(g => Number(g.id) === Number(group.id))) return prev;
          const next = [...prev, { ...group, is_group: true }];
          try { localStorage.setItem(`chat_groups_${user.id}`, JSON.stringify(next)); } catch (_) { }
          return next;
        });
      } else {
        fetchGroups();
      }
    });

    socket.on('removed_from_group', (payload) => {
      const groupId = payload?.groupId;
      if (!groupId) return;
      setGroups(prev => {
        const next = prev.filter(g => Number(g.id) !== Number(groupId));
        try { localStorage.setItem(`chat_groups_${user.id}`, JSON.stringify(next)); } catch (_) { }
        return next;
      });
      if (activeChatRef.current?.is_group && Number(activeChatRef.current.id) === Number(groupId)) {
        setActiveChat(null);
        setShowGroupDetailsModal(false);
      }
    });

    socket.on('group_updated', (groupPayload) => {
      if (!groupPayload?.id) return;
      setGroups(prev => prev.map(g => Number(g.id) === Number(groupPayload.id) ? { ...g, ...groupPayload, is_group: true } : g));
      if (activeChatRef.current?.is_group && Number(activeChatRef.current.id) === Number(groupPayload.id)) {
        setActiveChat(prev => prev ? { ...prev, ...groupPayload, is_group: true } : prev);
      }
    });

    socket.on('view_once_consumed', (payload) => {
      const messageId = payload?.messageId;
      if (!messageId) return;
      setMessages(prev => prev.map(m => (
        Number(m.id) === Number(messageId)
          ? { ...m, view_once_opened_at: payload.opened_at, view_once_opened_by: payload.opened_by }
          : m
      )));
    });

    socket.on('call:incoming', (payload = {}) => {
      if (activeCallRef.current || callStateRef.current !== 'idle') {
        socket.emit('call:decline', { callId: payload.callId });
        return;
      }
      setCallError('');
      setActiveCall({
        callId: payload.callId,
        callType: payload.callType,
        peerUserId: payload?.from?.id,
        peerInfo: payload?.from,
        direction: 'incoming'
      });
      setCallState('ringing');
    });

    socket.on('call:ringing', (payload = {}) => {
      setActiveCall(prev => (prev && prev.direction === 'outgoing' ? { ...prev, callId: payload.callId } : prev));
    });

    socket.on('call:accepted', async (payload = {}) => {
      const call = activeCallRef.current;
      if (!call || call.callId !== payload.callId || call.direction !== 'outgoing') return;
      setCallState('connecting');
      try {
        const pc = createPeerConnection(call.callId, call.peerUserId);
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit('call:offer', { callId: call.callId, sdp: offer });
      } catch (err) {
        console.error('Failed to create call offer:', err.message);
        setCallError('Failed to connect the call.');
        socket.emit('call:end', { callId: call.callId });
        resetCallState();
        setCallState('failed');
        scheduleAutoDismiss('failed');
      }
    });

    socket.on('call:offer', async (payload = {}) => {
      const call = activeCallRef.current;
      if (!call || call.callId !== payload.callId || callRoleRef.current !== 'callee') return;
      try {
        const pc = peerConnectionRef.current || createPeerConnection(call.callId, call.peerUserId);
        await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
        await flushPendingIceCandidates();
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('call:answer', { callId: call.callId, sdp: answer });
      } catch (err) {
        console.error('Failed to answer call:', err.message);
        setCallError('Failed to connect the call.');
        socket.emit('call:end', { callId: call.callId });
        resetCallState();
        setCallState('failed');
        scheduleAutoDismiss('failed');
      }
    });

    socket.on('call:answer', async (payload = {}) => {
      const call = activeCallRef.current;
      const pc = peerConnectionRef.current;
      if (!call || !pc || call.callId !== payload.callId || callRoleRef.current !== 'caller') return;
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
        await flushPendingIceCandidates();
      } catch (err) {
        console.error('Failed to apply call answer:', err.message);
      }
    });

    socket.on('call:ice-candidate', async (payload = {}) => {
      const call = activeCallRef.current;
      if (!call || call.callId !== payload.callId || !payload.candidate) return;
      const pc = peerConnectionRef.current;
      if (pc && pc.remoteDescription) {
        try { await pc.addIceCandidate(new RTCIceCandidate(payload.candidate)); } catch (_) { }
      } else {
        pendingIceCandidatesRef.current.push(payload.candidate);
      }
    });

    socket.on('call:busy', () => {
      resetCallState();
      setCallState('busy');
      scheduleAutoDismiss('busy');
    });

    socket.on('call:offline', () => {
      resetCallState();
      setCallState('offline');
      scheduleAutoDismiss('offline');
    });

    socket.on('call:ended', (payload = {}) => {
      const call = activeCallRef.current;
      if (!call || (payload.callId && call.callId !== payload.callId)) return;
      const reason = payload.reason || 'ended';
      const displayState = reason === 'disconnected' ? 'failed' : reason;
      resetCallState();
      setCallState(displayState);
      scheduleAutoDismiss(displayState);
    });

    socket.on('call:error', (payload = {}) => {
      setCallError(payload?.error || 'Call failed.');
      resetCallState();
      setCallState('idle');
    });

    socket.on('connect_error', (err) => {
      console.error('Socket connection error:', err?.message || err);
    });

    return () => {
      cancelled = true;
      if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
      if (recordingTimerRef.current) clearInterval(recordingTimerRef.current);
      if (viewOnceTimerRef.current) clearTimeout(viewOnceTimerRef.current);
      if (mediaRecorderRef.current) {
        try {
          if (mediaRecorderRef.current.state !== 'inactive') mediaRecorderRef.current.stop();
          mediaRecorderRef.current.stream?.getTracks?.().forEach(track => track.stop());
        } catch (_) { }
      }
      if (recordedAudioUrlRef.current) {
        URL.revokeObjectURL(recordedAudioUrlRef.current);
        recordedAudioUrlRef.current = null;
      }
      cleanupCallResources();
      if (socket) socket.disconnect();
    };
  }, [user.id]);

  useEffect(() => {
    if (activeChat) {
      fetchMessages(activeChat);
      if (!activeChat.is_group) {
        setTimeout(() => {
          if (socket) socket.emit('mark_read', { userId: user.id, friendId: activeChat.id });
        }, 300);
      }
    }
  }, [activeChat]);

  useEffect(() => {
    const query = addFriendUsername.trim();
    if (!query) {
      setUserSearchResults([]);
      setIsSearchingUsers(false);
      return undefined;
    }
    setUserSearchResults([]);
    let cancelled = false;
    const timeoutId = setTimeout(async () => {
      setIsSearchingUsers(true);
      try {
        const res = await axios.get(`${API_URL}/users/search`, { params: { q: query } });
        if (!cancelled) setUserSearchResults(res.data || []);
      } catch (_) {
        if (!cancelled) setUserSearchResults([]);
      } finally {
        if (!cancelled) setIsSearchingUsers(false);
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
    };
  }, [addFriendUsername]);

  useEffect(() => {
    if (!isAtBottomRef.current) return;
    messagesEndRef.current?.scrollIntoView({ behavior: 'auto' });
  }, [messages]);

  const fetchContacts = async () => {
    try {
      const res = await axios.get(`${API_URL}/contacts/${user.id}`);
      const base = res.data || [];
      setContacts(base);
      setOnlineUserIds(new Set(base.filter(c => c.online).map(c => Number(c.id))));
      try { localStorage.setItem(`chat_contacts_${user.id}`, JSON.stringify(base)); } catch (_) { }
      return base;
    } catch (err) { console.error(err); return null; }
  };

  const fetchGroups = async () => {
    try {
      const res = await axios.get(`${API_URL}/groups/${user.id}`);
      let groupsList = res.data || [];
      groupsList = groupsList.slice().sort((a, b) => {
        const an = String(a.name || '').toLowerCase();
        const bn = String(b.name || '').toLowerCase();
        if (an === 'announcements' && bn !== 'announcements') return -1;
        if (bn === 'announcements' && an !== 'announcements') return 1;
        return 0;
      });
      setGroups(groupsList);
      try { localStorage.setItem(`chat_groups_${user.id}`, JSON.stringify(groupsList)); } catch (_) { }
      return groupsList;
    } catch (err) { console.error(err); return null; }
  };

  const fetchRequests = async () => {
    try {
      const res = await axios.get(`${API_URL}/contacts/requests/${user.id}`);
      setFriendRequests(res.data);
    } catch (err) { console.error(err); }
  };

  // Loads contacts/groups/requests together, driving the sidebar's
  // loading skeleton, slow-network indicator, and error state. Reused
  // both on mount and by the "Try Again" retry button.
  const loadInitialData = async () => {
    setInitialLoadError(false);
    initialSlowTimer.start();
    let contactsData = null;
    let groupsData = null;
    try {
      [contactsData, groupsData] = await Promise.all([
        fetchContacts(),
        fetchGroups(),
        fetchRequests()
      ]);
    } finally {
      initialSlowTimer.stop();
      setInitialLoading(false);
    }
    if (contactsData === null && groupsData === null && !hadCachedDataRef.current) {
      setInitialLoadError(true);
    }
    return groupsData;
  };

  const handleRetryInitialLoad = () => {
    setInitialLoading(true);
    loadInitialData();
  };

  const openConversationFromNotification = async (target) => {
    if (!target || !target.conversationId) return;
    try {
      if (target.conversationType === 'group') {
        const gid = Number(target.conversationId);
        const list = await fetchGroups();
        const g = (list || groups).find(gr => Number(gr.id) === gid);
        if (g) setActiveChat({ ...g, is_group: true });
      } else {
        const uid = Number(target.conversationId);
        const list = await fetchContacts();
        const c = (list || contacts).find(ct => Number(ct.id) === uid);
        if (c) setActiveChat(c);
      }
    } catch (e) {
      console.error('Failed to open conversation from notification:', e && e.message ? e.message : e);
    }
  };

  const fetchMessages = async (chat) => {
    setMessagesLoading(true);
    setMessagesLoadError(false);
    messagesSlowTimer.start();
    try {
      const res = await axios.get(`${API_URL}/messages/${user.id}/${chat.id}?isGroup=${chat.is_group ? 'true' : 'false'}&limit=50`);
      const decrypted = await Promise.all((res.data || []).map(decryptIncomingMessage));
      setMessages(decrypted);
      isAtBottomRef.current = true;
      requestAnimationFrame(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'auto' });
      });
    } catch (err) {
      console.error(err);
      setMessagesLoadError(true);
    } finally {
      messagesSlowTimer.stop();
      setMessagesLoading(false);
    }
  };

  const fetchPinnedMessages = async (chat) => {
    try {
      const chatType = chat.is_group ? 'group' : 'direct';
      const res = await axios.get(`${API_URL}/messages/pinned/${chatType}/${chat.id}`);
      setPinnedMessages(res.data || []);
    } catch (_) { }
  };

  const handleInputChange = (e) => {
    setNewMessage(e.target.value);
    if (!socket || !activeChat) return;
    socket.emit('typing', { targetId: activeChat.id, isGroup: !!activeChat.is_group });
    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    typingTimeoutRef.current = setTimeout(() => {
      socket.emit('stop_typing', { targetId: activeChat.id, isGroup: !!activeChat.is_group });
    }, 2000);
  };

  const handleAddFriend = async (friend) => {
    if (!friend?.username || sentFriendRequests[friend.id]) return;
    try {
      await axios.post(`${API_URL}/contacts/add`, {
        friendUsername: friend.username
      });
      setSentFriendRequests(prev => ({ ...prev, [friend.id]: true }));
    } catch (err) {
      alert(err.response?.data?.error || 'Failed to send request');
    }
  };

  const handleRespondRequest = async (requestId, status) => {
    try {
      await axios.post(`${API_URL}/contacts/requests/respond`, { requestId, status });
      setFriendRequests(prev => prev.filter(r => r.request_id !== requestId));
      if (status === 'accepted') {
        await fetchContacts();
      }
    } catch (err) { console.error('Failed to respond to request', err); }
  };

  const handleCreateGroup = async (e) => {
    e.preventDefault();
    if (!newGroupName.trim() || selectedContacts.length === 0) return alert('Groups need a name and at least 1 friend');
    try {
      const res = await axios.post(`${API_URL}/groups/create`, {
        name: newGroupName,
        description: newGroupDesc,
        memberIds: selectedContacts
      });
      setGroups((prev) => [...prev, res.data]);
      if (socket) socket.emit('join_new_group', res.data.id);
      setShowGroupModal(false);
      setNewGroupName('');
      setNewGroupDesc('');
      setSelectedContacts([]);
      setActiveChat(res.data);
    } catch (err) {
      alert(err.response?.data?.error || 'Failed to create group');
    }
  };

  const toggleContactSelection = (contactId) => {
    if (selectedContacts.includes(contactId)) {
      setSelectedContacts(selectedContacts.filter(id => id !== contactId));
    } else {
      setSelectedContacts([...selectedContacts, contactId]);
    }
  };

  const handleSendMessage = (e, customPayload) => {
    if (e) e.preventDefault();
    if (!activeChat) return;
    if (activeChat.is_group && String(activeChat.name || '').toLowerCase() === 'announcements' && !isAdmin) return;
    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    socket.emit('stop_typing', { targetId: activeChat.id, isGroup: !!activeChat.is_group });
    const content = customPayload?.content || newMessage.trim();
    const type = customPayload?.type || 'text';
    const imageUrl = customPayload?.imageUrl || null;
    if (!content && !imageUrl && !recordedAudioBlob) return;
    if (!customPayload && recordedAudioBlob && !content && !imageUrl) {
      (async () => {
        try {
          const formData = new FormData();
          formData.append('file', recordedAudioBlob, 'voice.webm');
          const res = await axios.post(`${API_URL}/upload`, formData, {
            headers: { 'Content-Type': 'multipart/form-data' }
          });
          socket.emit('send_message', {
            senderId: user.id,
            receiverId: activeChat.is_group ? null : activeChat.id,
            groupId: activeChat.is_group ? activeChat.id : null,
            content: '',
            imageUrl: res.data.url,
            type: 'audio',
            reply: replyTo
          });
          setRecordedAudioBlob(null);
          if (recordedAudioUrlRef.current) URL.revokeObjectURL(recordedAudioUrlRef.current);
          recordedAudioUrlRef.current = null;
          setRecordedAudioUrl(null);
          setReplyTo(null);
        } catch (err) {
          alert('Failed to send voice message');
        }
      })();
      return;
    }
    (async () => {
      let ciphertext = null, nonce = null;
      if (!activeChat.is_group && content) {
        try {
          const recipientKey = await fetchPublicKey(activeChat.id, user.token);
          if (recipientKey) {
            const enc = await encryptForRecipient(content, recipientKey, user.id);
            ciphertext = enc.ciphertext;
            nonce = enc.nonce;
          }
        } catch (e) {
          console.error('[e2ee] Encryption failed, falling back to plaintext:', e && e.message ? e.message : e);
        }
      }
      socket.emit('send_message', {
        senderId: user.id,
        receiverId: activeChat.is_group ? null : activeChat.id,
        groupId: activeChat.is_group ? activeChat.id : null,
        content: ciphertext ? '' : content,
        ciphertext,
        nonce,
        imageUrl,
        type,
        viewOnce: !!customPayload?.viewOnce,
        reply: replyTo
      });
    })();
    if (!customPayload) setNewMessage('');
    setReplyTo(null);
  };

  useEffect(() => {
    const el = messageInputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const maxHeight = 140;
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
    el.style.overflowY = el.scrollHeight > maxHeight ? 'auto' : 'hidden';
  }, [newMessage, activeChat]);

  const handleComposerKeyDown = (e) => {
    const enterToSend = localSettingsRef.current.enter_to_send !== false;
    if (e.key !== 'Enter') return;
    if (enterToSend) {
      if (!e.shiftKey) {
        e.preventDefault();
        handleSendMessage(e);
      }
    } else {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        handleSendMessage(e);
      }
    }
  };

  const uploadAndSend = async (file, type, viewOnce = false) => {
    const formData = new FormData();
    formData.append('file', file);
    try {
      const res = await axios.post(`${API_URL}/upload`, formData, {
        headers: { 'Content-Type': 'multipart/form-data' }
      });
      handleSendMessage(null, {
        content: '',
        imageUrl: res.data.url,
        type,
        viewOnce
      });
    } catch (err) {
      alert('Failed to upload file');
    }
  };

  const handleFileUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    e.target.value = '';
    if (file.type.startsWith('image/')) {
      const previewUrl = URL.createObjectURL(file);
      setPendingImage({ file, previewUrl, viewOnce: false });
      setPendingVideo(null);
      return;
    }
    if (file.type.startsWith('video/')) {
      const previewUrl = URL.createObjectURL(file);
      setPendingVideo({ file, previewUrl });
      setPendingImage(null);
      return;
    }
    await uploadAndSend(file, file.type.startsWith('audio/') ? 'audio' : 'image');
  };

  const confirmSendPendingImage = async () => {
    if (!pendingImage) return;
    const { file, viewOnce, previewUrl } = pendingImage;
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await axios.post(`${API_URL}/upload`, formData, {
        headers: { 'Content-Type': 'multipart/form-data' }
      });
      setPendingImage(null);
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      handleSendMessage(null, {
        content: '',
        imageUrl: res.data.url,
        type: 'image',
        viewOnce
      });
    } catch (err) {
      alert('Failed to upload image');
    }
  };

  const confirmSendPendingVideo = async () => {
    if (!pendingVideo) return;
    const { file, previewUrl } = pendingVideo;
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await axios.post(`${API_URL}/upload`, formData, {
        headers: { 'Content-Type': 'multipart/form-data' }
      });
      setPendingVideo(null);
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      handleSendMessage(null, {
        content: '',
        imageUrl: res.data.url,
        type: 'video'
      });
    } catch (err) {
      alert('Failed to upload video');
    }
  };

  const cancelPendingImage = () => {
    if (pendingImage?.previewUrl) URL.revokeObjectURL(pendingImage.previewUrl);
    setPendingImage(null);
  };

  const cancelPendingVideo = () => {
    if (pendingVideo?.previewUrl) URL.revokeObjectURL(pendingVideo.previewUrl);
    setPendingVideo(null);
  };

  const openViewOnce = async (msg) => {
    if (viewOnceOpeningId) return;
    setViewOnceOpeningId(msg.id);
    try {
      const res = await axios.post(`${API_URL}/messages/${msg.id}/view-once/open`);
      setMessages(prev => prev.map(m => (
        m.id === msg.id ? { ...m, view_once_opened_at: res.data.opened_at, view_once_opened_by: user.id } : m
      )));
      const url = normalizeMediaUrl(res.data.image_url);
      if (viewOnceTimerRef.current) clearTimeout(viewOnceTimerRef.current);
      setViewOnceViewer({ messageId: msg.id, url });
      viewOnceTimerRef.current = setTimeout(() => {
        setViewOnceViewer(null);
      }, 4000);
    } catch (err) {
      setMessages(prev => prev.map(m => (
        m.id === msg.id ? { ...m, view_once_opened_at: m.view_once_opened_at || new Date().toISOString() } : m
      )));
      alert(err.response?.data?.error || 'This photo is no longer available.');
    } finally {
      setViewOnceOpeningId(null);
    }
  };

  const closeViewOnceViewer = () => {
    if (viewOnceTimerRef.current) {
      clearTimeout(viewOnceTimerRef.current);
      viewOnceTimerRef.current = null;
    }
    setViewOnceViewer(null);
  };

  const handleDownloadMedia = (msg) => {
    const url = normalizeMediaUrl(msg.image_url);
    if (!url) return;
    try {
      const u = new URL(url);
      if (u.origin === new URL(API_BASE_URL).origin && u.pathname.startsWith('/uploads/')) {
        u.pathname = `${u.pathname}/download`;
        window.open(u.toString(), '_blank');
      } else {
        window.open(url, '_blank');
      }
    } catch (_) {
      window.open(url, '_blank');
    }
  };

  const startRecording = async () => {
    try {
      if (recordedAudioUrlRef.current) URL.revokeObjectURL(recordedAudioUrlRef.current);
      recordedAudioUrlRef.current = null;
      setRecordedAudioUrl(null);
      setRecordedAudioBlob(null);
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];
      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };
      mediaRecorder.onstop = async () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        setRecordedAudioBlob(audioBlob);
        const url = URL.createObjectURL(audioBlob);
        recordedAudioUrlRef.current = url;
        setRecordedAudioUrl(url);
      };
      mediaRecorder.start();
      setIsRecording(true);
      setRecordingSeconds(0);
      if (recordingTimerRef.current) clearInterval(recordingTimerRef.current);
      recordingTimerRef.current = setInterval(() => setRecordingSeconds(s => s + 1), 1000);
    } catch (err) {
      alert('Microphone access denied or unavailable');
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      mediaRecorderRef.current.stream.getTracks().forEach(track => track.stop());
      setIsRecording(false);
      if (recordingTimerRef.current) {
        clearInterval(recordingTimerRef.current);
        recordingTimerRef.current = null;
      }
    }
  };

  const cancelRecording = () => {
    if (isRecording) stopRecording();
    setRecordingSeconds(0);
    setRecordedAudioBlob(null);
    if (recordedAudioUrlRef.current) URL.revokeObjectURL(recordedAudioUrlRef.current);
    recordedAudioUrlRef.current = null;
    setRecordedAudioUrl(null);
  };

  const formatTime = (ts) => {
    if (!ts) return '';
    if (typeof ts === 'string' && ts.includes(' ') && !ts.includes('T')) {
      const iso = ts.replace(' ', 'T') + 'Z';
      return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  const formatTimer = (s) => {
    const mm = String(Math.floor(s / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    return `${mm}:${ss}`;
  };

  const handleLogout = () => {
    unregisterPushNotifications();
    resetE2eeState();
    localStorage.removeItem('chat_user');
    setUser(null);
  };

  const handleMessagesScroll = () => {
    const el = messagesContainerRef.current;
    if (!el) return;
    const thresholdPx = 80;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    isAtBottomRef.current = distanceFromBottom <= thresholdPx;
  };

  const closeOverlays = () => {
    setMessageMenu(null);
    setSelectedMessageId(null);
    setQuickReactionFor(null);
    setQuickReactionAnchor(null);
    if (!emojiPickerHoverRef.current) {
      setEmojiPickerFor(null);
      setEmojiPickerAnchor(null);
    }
  };
  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        setLightboxUrl(null);
        setMessageMenu(null);
        setEmojiPickerFor(null);
        setEmojiPickerAnchor(null);
        setEditingMessage(null);
        setForwardingMessage(null);
        setShowSearch(false);
      }
    };
    const onClick = () => closeOverlays();
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('click', onClick);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('click', onClick);
    };
  }, []);

  const openMessageMenu = (message, x, y) => {
    setMessageMenu({ message, x, y });
  };

  useEffect(() => {
    if (!messageMenu || !messageMenuRef.current) return;
    const el = messageMenuRef.current;
    const rect = el.getBoundingClientRect();
    const overflowRight = rect.right - (window.innerWidth - 8);
    const overflowBottom = rect.bottom - (window.innerHeight - 8);
    if (overflowRight > 0) el.style.left = `${Math.max(8, messageMenu.x - overflowRight)}px`;
    if (overflowBottom > 0) el.style.top = `${Math.max(8, messageMenu.y - rect.height - overflowBottom)}px`;
  }, [messageMenu]);

  const startLongPress = (message, touchEvent) => {
    if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
    const t = touchEvent.touches?.[0];
    if (!t) return;
    longPressTimerRef.current = setTimeout(() => {
      openMessageMenu(message, t.clientX, t.clientY);
      setEmojiPickerFor(null);
      setEmojiPickerAnchor(null);
    }, 550);
  };

  const cancelLongPress = () => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  };

  const buildReplySnapshot = (msg) => {
    if (!msg?.id) return null;
    const replyType = msg.type || 'text';
    const canIncludeImage = (replyType === 'image' || replyType === 'audio' || replyType === 'gif') && !(msg.view_once && !msg.view_once_opened_at);
    return {
      id: msg.id,
      type: replyType,
      content: (replyType === 'text' || replyType === 'call') ? (msg.content || '') : (msg.view_once ? '[View once photo]' : ''),
      imageUrl: canIncludeImage ? (msg.image_url || '') : '',
      senderUsername: Number(msg.sender_id) === Number(user.id) ? (user.display_name || user.username) : (msg.sender_display_name || msg.sender_username || activeChat?.display_name || activeChat?.username || 'Unknown')
    };
  };

  const openEmojiPicker = (messageId, x, y) => {
    if (localSettingsRef.current.emoji_reactions === false) return;
    setEmojiPickerFor(messageId);
    setEmojiPickerAnchor({ x, y });
    setMessageMenu(null);
  };

  const openQuickReactions = (messageId, x, y) => {
    if (localSettingsRef.current.emoji_reactions === false) return;
    const width = 220;
    const clampedX = Math.min(Math.max(8, x), window.innerWidth - width - 8);
    const clampedY = Math.min(y, window.innerHeight - 60);
    setQuickReactionFor(messageId);
    setQuickReactionAnchor({ x: clampedX, y: clampedY });
    setMessageMenu(null);
  };

  const handleToggleReaction = (messageId, emoji) => {
    if (!socket || !messageId || !emoji) return;
    socket.emit('toggle_reaction', { messageId, userId: user.id, emoji });
  };

  const handleCopyMessage = (msg) => {
    if (msg.content) {
      navigator.clipboard.writeText(msg.content);
      alert('Message copied to clipboard!');
    }
    setMessageMenu(null);
  };

  const handleEditMessageSubmit = async () => {
    if (!editingMessage || !editContent.trim()) return;
    try {
      await axios.put(`${API_URL}/messages/${editingMessage.id}/edit`, { content: editContent.trim() });
      setMessages(prev => prev.map(m => (m.id === editingMessage.id ? { ...m, content: editContent.trim(), edited: true } : m)));
      setEditingMessage(null);
    } catch (err) {
      alert('Failed to edit message');
    }
  };

  const handleDeleteMessage = async (msg, forEveryone = false) => {
    try {
      await axios.delete(`${API_URL}/messages/${msg.id}?forEveryone=${forEveryone}`);
      if (forEveryone) {
        setMessages(prev => prev.map(m => (m.id === msg.id ? { ...m, content: 'This message was deleted', deleted_for_everyone: true, image_url: null } : m)));
      } else {
        setMessages(prev => prev.filter(m => m.id !== msg.id));
      }
      setMessageMenu(null);
    } catch (err) {
      alert('Failed to delete message');
    }
  };

  const handleStarMessage = async (msg) => {
    try {
      await axios.post(`${API_URL}/messages/${msg.id}/star`);
      alert('Starred status updated!');
      setMessageMenu(null);
    } catch (err) {
      alert('Failed to star message');
    }
  };

  const handlePinMessage = async (msg) => {
    if (!activeChat) return;
    try {
      const chatType = activeChat.is_group ? 'group' : 'direct';
      await axios.post(`${API_URL}/messages/${msg.id}/pin`, { chatType, chatTargetId: activeChat.id });
      fetchPinnedMessages(activeChat);
      setMessageMenu(null);
    } catch (err) {
      alert('Failed to pin message');
    }
  };

  const handleForwardMessageSubmit = (targetChat) => {
    if (!forwardingMessage || !targetChat) return;
    if (forwardingMessage.view_once && !forwardingMessage.view_once_opened_at) {
      alert('This view-once photo cannot be forwarded.');
      setForwardingMessage(null);
      return;
    }
    socket.emit('send_message', {
      senderId: user.id,
      receiverId: targetChat.is_group ? null : targetChat.id,
      groupId: targetChat.is_group ? targetChat.id : null,
      content: forwardingMessage.content,
      imageUrl: forwardingMessage.image_url,
      type: forwardingMessage.type
    });
    alert(`Forwarded to ${targetChat.display_name || targetChat.name || targetChat.username}!`);
    setForwardingMessage(null);
  };

  const highlightMatch = (text, query) => {
    if (!query || !text) return text;
    const parts = text.split(new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'));
    return parts.map((part, i) =>
      part.toLowerCase() === query.toLowerCase() ? (
        <mark key={i} className="search-highlight">{part}</mark>
      ) : part
    );
  };

  const renderReplySnippet = (msg) => {
    if (!msg?.reply_to_id) return null;
    const t = msg.reply_to_type || 'text';
    const label =
      t === 'gif' ? '[GIF]' :
        t === 'image' ? (msg.reply_to_content === '[View once photo]' ? '[View once photo]' : '[Image]') :
          t === 'audio' ? '[Voice message]' :
            (msg.reply_to_content || '');
    return (
      <div className="reply-quote">
        <div className="reply-quote-header">
          <ReplyIcon size={14} />
          <span>{msg.reply_to_sender_username || 'Reply'}</span>
        </div>
        <div className="reply-quote-body">{label}</div>
      </div>
    );
  };

  const isAdmin = user.username === 'maaz_khan' || user.role === 'admin';
  const isAnnouncementsReadOnly = !!(activeChat && activeChat.is_group && String(activeChat.name || '').toLowerCase() === 'announcements' && !isAdmin);

  // Whether the in-chat message search (searchQuery) has completed and
  // found nothing among the messages already loaded for this chat.
  const trimmedSearchQuery = searchQuery.trim();
  const hasSearchResults = !trimmedSearchQuery || messages.some((msg) => {
    if (activeChat?.is_group && Number(msg.group_id) !== Number(activeChat.id)) return false;
    if (activeChat && !activeChat.is_group && msg.group_id) return false;
    if (activeChat && !activeChat.is_group && Number(msg.sender_id) !== Number(user.id) && Number(msg.sender_id) !== Number(activeChat.id)) return false;
    return msg.content?.toLowerCase().includes(trimmedSearchQuery.toLowerCase());
  });

  return (
    <div className="app-container">
      <CallOverlay
        callState={callState}
        callDismissing={callDismissing}
        activeCall={activeCall || (callState !== 'idle' ? lastCallInfoRef.current : null)}
        callDuration={callDuration}
        isMuted={isMuted}
        isCameraOff={isCameraOff}
        isSpeakerOn={isSpeakerOn}
        callError={callError}
        onDismissError={() => setCallError('')}
        localVideoRef={localVideoRef}
        remoteVideoRef={remoteVideoRef}
        remoteAudioRef={remoteAudioRef}
        onAccept={acceptCall}
        onDecline={declineCall}
        onEnd={endCall}
        onToggleMute={toggleMute}
        onToggleCamera={toggleCamera}
        onToggleSpeaker={toggleSpeaker}
        onSwitchCamera={switchCamera}
        normalizeMediaUrl={normalizeMediaUrl}
      />
      <div className="chat-layout">
        <div className={`sidebar ${activeChat ? 'mobile-hidden' : ''}`}>
          <div className="sidebar-header">
            <div className="sidebar-header-actions" onClick={() => setShowProfileModal(true)} style={{ cursor: 'pointer' }}>
              <span className="avatar-wrapper">
                {user.avatar_url ? (
                  <img src={normalizeMediaUrl(user.avatar_url)} alt="Avatar" className="circular-avatar" style={{ width: 36, height: 36 }} />
                ) : (
                  <div className="avatar" style={{ width: 36, height: 36, fontSize: 15 }}>
                    {(user.display_name || user.username || 'U').charAt(0).toUpperCase()}
                  </div>
                )}
                <span className="online-status-dot" />
              </span>
              <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.2 }}>
                <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-main)' }}>{user.display_name || user.username}</span>
                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Online</span>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <button className="logout-btn" onClick={() => setShowStarredModal(true)} title="Starred Messages">
                <Star size={17} />
              </button>
              <button className="logout-btn" onClick={() => setShowSettingsModal(true)} title="Settings">
                <Settings size={17} />
              </button>
              {(user.username === 'maaz_khan' || user.role === 'admin') && (
                <Link className="logout-btn" to="/admin" title="Admin">
                  <Shield size={17} />
                </Link>
              )}
              <button className="logout-btn" onClick={handleLogout} title="Log Out">
                <LogOut size={17} />
              </button>
            </div>
          </div>
          <div
            title="Direct messages in Aerio are end-to-end encrypted — only you and the person you're messaging can read them."
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, fontSize: 12, fontWeight: 600, color: '#10b981', background: '#10b98118', border: '1px solid #10b98155', borderRadius: 8, padding: '6px 10px', margin: '0 15px 10px' }}
          >
            <span role="img" aria-label="lock">🔒</span>
            End-to-End Encrypted
          </div>
          <div className="add-friend-search">
            <input
              type="text"
              className="add-friend-input"
              placeholder="Search users by username..."
              value={addFriendUsername}
              onChange={(e) => setAddFriendUsername(e.target.value)}
              aria-label="Search users by username"
            />
            {addFriendUsername.trim() && (
              <div className="user-search-results" aria-live="polite">
                {isSearchingUsers ? (
                  <div className="user-search-status">Searching...</div>
                ) : userSearchResults.length > 0 ? (
                  userSearchResults.map(result => {
                    const requestSent = sentFriendRequests[result.id];
                    return (
                      <div className="user-search-card" key={result.id}>
                        {result.avatar_url ? (
                          <img src={normalizeMediaUrl(result.avatar_url)} alt="" className="circular-avatar user-search-avatar" />
                        ) : (
                          <div className="avatar user-search-avatar">
                            {(result.display_name || result.username || 'U').charAt(0).toUpperCase()}
                          </div>
                        )}
                        <div className="user-search-details">
                          <span className="user-search-name">{result.display_name || result.username}</span>
                          <span className="user-search-username">@{result.username}</span>
                        </div>
                        <button
                          type="button"
                          className={`user-search-add-button ${requestSent ? 'sent' : ''}`}
                          title={requestSent ? 'Friend request sent' : `Add ${result.username}`}
                          aria-label={requestSent ? `Friend request sent to ${result.username}` : `Add ${result.username} as a friend`}
                          onClick={() => handleAddFriend(result)}
                          disabled={requestSent}
                        >
                          {requestSent ? <><Check size={15} /> Request Sent</> : <UserPlus size={17} />}
                        </button>
                      </div>
                    );
                  })
                ) : (
                  <NoResultsState compact query={addFriendUsername.trim()} />
                )}
              </div>
            )}
          </div>
          <div className="section-header">
            <span>GROUPS & DIRECT</span>
            <div style={{ display: 'flex', gap: 6 }}>
              <button className="logout-btn" onClick={() => setShowFriendRequestsModal(true)} style={{ padding: '4px', margin: 0, position: 'relative' }} title="Friend Requests">
                <Bell size={14} />
                {friendRequests.length > 0 && (
                  <span style={{ position: 'absolute', top: -4, right: -4, background: '#ef4444', color: '#fff', borderRadius: '50%', minWidth: 14, height: 14, padding: '0 3px', fontSize: 9, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1 }}>
                    {friendRequests.length}
                  </span>
                )}
              </button>
              <button className="logout-btn" onClick={() => setShowGroupModal(true)} style={{ padding: '4px', margin: 0 }} title="Create Group">
                <Users size={14} />
              </button>
            </div>
          </div>
          <div className="contacts-list">
            {initialLoading ? (
              <>
                {initialLoadSlow && <SlowNetworkState compact />}
                <ContactsSkeleton />
              </>
            ) : initialLoadError && !isOnline ? (
              <NoInternetState compact onRetry={handleRetryInitialLoad} />
            ) : initialLoadError ? (
              <ErrorState
                compact
                message="We couldn't load your chats. Please try again."
                onRetry={handleRetryInitialLoad}
              />
            ) : contacts.length === 0 && groups.length === 0 ? (
              <div className="empty-state">No contacts yet. Add a friend to start chatting!</div>
            ) : (
              <>
                {groups.map(group => (
                  <GroupRow
                    key={`g_${group.id}`}
                    group={group}
                    isActive={activeChat?.id === group.id && !!activeChat?.is_group}
                    unread={unreadCounts[`group_${group.id}`] || 0}
                    onSelect={setActiveChat}
                    normalizeMediaUrl={normalizeMediaUrl}
                  />
                ))}
                {contacts.map(contact => (
                  <ContactRow
                    key={`c_${contact.id}`}
                    contact={contact}
                    isActive={activeChat?.id === contact.id && !activeChat?.is_group}
                    unread={unreadCounts[`user_${contact.id}`] || 0}
                    isTyping={!!typingUsers[contact.id]}
                    isOnline={onlineUserIds.has(Number(contact.id))}
                    onSelect={setActiveChat}
                    normalizeMediaUrl={normalizeMediaUrl}
                  />
                ))}
              </>
            )}
          </div>
          <div style={{ padding: '15px', textAlign: 'center', fontSize: '11px', color: 'var(--text-muted)', borderTop: '1px solid var(--border-color)' }}>
            Created by Maaz
          </div>
        </div>
        <div className={`chat-area ${!activeChat ? 'mobile-hidden' : ''}`}>
          {activeChat ? (
            <>
              <div className="chat-header">
                <button className="mobile-back-btn" onClick={() => setActiveChat(null)}>
                  <ArrowLeft size={20} />
                </button>
                <div
                  className="chat-header-user-info"
                  onClick={async () => {
                    if (activeChat.is_group) {
                      setGroupEditName(activeChat.name || '');
                      setGroupEditDesc(activeChat.description || '');
                      setShowGroupDetailsModal(true);
                      try {
                        const res = await axios.get(`${API_URL}/groups/${activeChat.id}/members`);
                        setGroupMembers(res.data || []);
                      } catch (_) {
                        setGroupMembers([]);
                      }
                    } else {
                      setViewingUserId(activeChat.id);
                    }
                  }}
                  style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', flex: 1 }}
                >
                  {activeChat.avatar_url ? (
                    <img src={normalizeMediaUrl(activeChat.avatar_url)} alt="Avatar" className="circular-avatar" style={{ width: 38, height: 38 }} />
                  ) : (
                    <div className={`avatar ${activeChat.is_group ? 'group' : ''}`} style={{ width: 38, height: 38, fontSize: 16 }}>
                      {activeChat.is_group ? <Users size={18} /> : (activeChat.username ? activeChat.username.charAt(0).toUpperCase() : '')}
                    </div>
                  )}
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <h2 style={{ fontSize: 16, margin: 0 }}>{activeChat.is_group ? activeChat.name : (activeChat.display_name || activeChat.username)}</h2>
                    </div>
                    {(() => {
                      const isFriendOnline = !activeChat.is_group && onlineUserIds.has(Number(activeChat.id));
                      const isTyping = !!typingUsers[activeChat.id];
                      const statusColor = isTyping || isFriendOnline ? '#10b981' : 'var(--text-muted)';
                      return (
                        <span style={{ fontSize: 11, color: statusColor, display: 'flex', alignItems: 'center', gap: 5 }}>
                          {isTyping ? (
                            'responding...'
                          ) : activeChat.is_group ? (
                            'Tap for group info'
                          ) : isFriendOnline ? (
                            <>
                              <span className="online-text-dot" style={{ background: '#10b981' }} />
                              Online
                            </>
                          ) : (
                            'Offline'
                          )}
                        </span>
                      );
                    })()}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  {!activeChat.is_group && (
                    <>
                      <button
                        className="logout-btn call-header-btn"
                        onClick={() => startCall(activeChat, 'voice')}
                        disabled={callState !== 'idle'}
                        title="Voice Call"
                      >
                        <Phone size={18} />
                      </button>
                      <button
                        className="logout-btn call-header-btn"
                        onClick={() => startCall(activeChat, 'video')}
                        disabled={callState !== 'idle'}
                        title="Video Call"
                      >
                        <Video size={18} />
                      </button>
                    </>
                  )}
                  <button className="logout-btn" onClick={() => setShowSearch(!showSearch)} title="Search Messages">
                    <Search size={18} />
                  </button>
                </div>
              </div>
              {showSearch && (
                <div className="chat-search-bar">
                  <Search size={16} color="var(--text-muted)" />
                  <input
                    type="text"
                    placeholder="Search in chat..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    autoFocus
                  />
                  <button className="close-btn" onClick={() => { setShowSearch(false); setSearchQuery(''); }}>
                    <X size={16} />
                  </button>
                </div>
              )}
              <div
                className="chat-messages"
                ref={messagesContainerRef}
                onScroll={handleMessagesScroll}
              >
                {messagesLoading ? (
                  <>
                    {messagesLoadSlow && <SlowNetworkState compact />}
                    <MessagesSkeleton />
                  </>
                ) : messagesLoadError && !isOnline ? (
                  <NoInternetState onRetry={() => fetchMessages(activeChat)} />
                ) : messagesLoadError ? (
                  <ErrorState onRetry={() => fetchMessages(activeChat)} />
                ) : trimmedSearchQuery && !hasSearchResults ? (
                  <NoResultsState query={trimmedSearchQuery} onClear={() => { setSearchQuery(''); }} />
                ) : null}
                {!messagesLoading && !messagesLoadError && messages.map((msg, idx) => {
                  const isSentByMe = Number(msg.sender_id) === Number(user.id);
                  if (activeChat.is_group && Number(msg.group_id) !== Number(activeChat.id)) return null;
                  if (!activeChat.is_group && msg.group_id) return null;
                  if (!activeChat.is_group && !isSentByMe && Number(msg.sender_id) !== Number(activeChat.id)) return null;
                  if (searchQuery.trim() && !msg.content?.toLowerCase().includes(searchQuery.toLowerCase())) {
                    return null;
                  }
                  return (
                    <div
                      key={msg.id || idx}
                      className={`message ${isSentByMe ? 'sent' : 'received'} ${selectedMessageId === msg.id ? 'selected' : ''}`}
                      style={(msg.type === 'image' || msg.type === 'audio' || msg.type === 'gif') ? { background: 'transparent', padding: 0, border: 'none' } : {}}
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelectedMessageId(prev => (prev === msg.id ? null : msg.id));
                      }}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        openMessageMenu(msg, e.clientX, e.clientY);
                      }}
                      onTouchStart={(e) => startLongPress(msg, e)}
                      onTouchEnd={cancelLongPress}
                      onTouchMove={cancelLongPress}
                      onTouchCancel={cancelLongPress}
                    >
                      {msg.type === 'audio' ? (
                        <div>
                          {!isSentByMe && activeChat.is_group && <div className="sender-name" style={{ color: 'var(--text-muted)' }}>{msg.sender_display_name || msg.sender_username}</div>}
                          <AudioPlayer src={normalizeMediaUrl(msg.image_url)} compact />
                        </div>
                      ) : msg.type === 'video' ? (
                        <div className="message-media-wrap">
                          {!isSentByMe && activeChat.is_group && <div className="sender-name" style={{ color: 'var(--text-muted)' }}>{msg.sender_display_name || msg.sender_username}</div>}
                          <video
                            src={normalizeMediaUrl(msg.image_url)}
                            controls
                            className="message-video"
                            onClick={(e) => {
                              e.stopPropagation();
                              setLightboxUrl(normalizeMediaUrl(msg.image_url));
                            }}
                          />
                        </div>
                      ) : msg.type === 'image' && msg.view_once ? (
                        <div>
                          {!isSentByMe && activeChat.is_group && <div className="sender-name" style={{ color: 'var(--text-muted)' }}>{msg.sender_display_name || msg.sender_username}</div>}
                          {isSentByMe ? (
                            <div className="view-once-tile view-once-sent">
                              <Lock size={16} />
                              <span>{msg.view_once_opened_at ? 'View once photo opened' : 'View once photo sent'}</span>
                            </div>
                          ) : msg.view_once_opened_at ? (
                            <div className="view-once-tile view-once-expired">
                              <Lock size={16} />
                              <span>View once photo expired</span>
                            </div>
                          ) : (
                            <button
                              type="button"
                              className="view-once-tile view-once-unopened"
                              onClick={(e) => { e.stopPropagation(); openViewOnce(msg); }}
                              disabled={viewOnceOpeningId === msg.id}
                            >
                              <Lock size={16} />
                              <span>{viewOnceOpeningId === msg.id ? 'Opening...' : 'Tap to view photo'}</span>
                            </button>
                          )}
                        </div>
                      ) : (msg.type === 'image' || msg.type === 'gif') ? (
                        <div className="message-media-wrap">
                          {!isSentByMe && activeChat.is_group && <div className="sender-name" style={{ color: 'var(--text-muted)' }}>{msg.sender_display_name || msg.sender_username}</div>}
                          <img
                            src={normalizeMediaUrl(msg.image_url)}
                            alt={msg.type === 'gif' ? 'GIF' : 'Shared'}
                            className="message-image"
                            onClick={(e) => {
                              e.stopPropagation();
                              setLightboxUrl(normalizeMediaUrl(msg.image_url));
                            }}
                          />
                          {msg.type === 'gif' && <span className="gif-badge">GIF</span>}
                        </div>
                      ) : msg.type === 'call' ? (() => {
                        const callContent = msg.content || '';
                        const isVideoCall = /video/i.test(callContent);
                        const isMissed = /^missed/i.test(callContent);
                        const isDeclined = /^declined/i.test(callContent);
                        const isNegative = isMissed || isDeclined;
                        const durationMatch = callContent.match(/—\s*([\d:]+)\s*$/);
                        const duration = durationMatch ? durationMatch[1] : null;
                        const CallIcon = isVideoCall
                          ? (isNegative ? VideoOff : Video)
                          : (isNegative ? PhoneOff : Phone);
                        const label = isMissed
                          ? `Missed ${isVideoCall ? 'video' : 'voice'} call`
                          : isDeclined
                            ? `Declined ${isVideoCall ? 'video' : 'voice'} call`
                            : isVideoCall ? 'Video call' : 'Voice call';
                        const canCallBack = callState === 'idle' && !activeChat.is_group;
                        return (
                          <div
                            className={`call-event-card ${isNegative ? 'call-event-negative' : ''} ${canCallBack ? 'is-callable' : ''}`}
                            onClick={canCallBack ? (e) => { e.stopPropagation(); startCall(activeChat, isVideoCall ? 'video' : 'voice'); } : undefined}
                            title={canCallBack ? `Call ${activeChat.display_name || activeChat.username} back` : undefined}
                          >
                            <span className="call-event-icon-wrap">
                              <CallIcon size={16} className="call-event-icon" />
                            </span>
                            <span className="call-event-text">
                              <span className="call-event-label">{label}</span>
                              {duration && <span className="call-event-duration">{duration}</span>}
                            </span>
                          </div>
                        );
                      })() : (
                        <div className="message-bubble">
                          {!isSentByMe && activeChat.is_group && (
                            <div className="sender-name">{msg.sender_display_name || msg.sender_username}</div>
                          )}
                          {renderReplySnippet(msg)}
                          {highlightMatch(msg.content, searchQuery)}
                          {msg.edited && <span className="edited-tag">(edited)</span>}
                        </div>
                      )}
                      {!(msg.type === 'image' && msg.view_once) && (
                        <div className="message-actions" onClick={(e) => e.stopPropagation()}>
                          <button
                            type="button"
                            className="message-action-btn"
                            title="React"
                            onClick={(e) => {
                              e.stopPropagation();
                              const rect = e.currentTarget.getBoundingClientRect();
                              if (quickReactionFor === msg.id) {
                                setQuickReactionFor(null);
                                setQuickReactionAnchor(null);
                              } else {
                                openQuickReactions(msg.id, rect.left, rect.bottom + 6);
                              }
                            }}
                          >
                            😀
                          </button>
                          <button
                            type="button"
                            className="message-action-btn"
                            title="Reply"
                            onClick={(e) => { e.stopPropagation(); setReplyTo(buildReplySnapshot(msg)); }}
                          >
                            <ReplyIcon size={14} />
                          </button>
                          {(msg.type === 'text' || msg.type === 'call') && (
                            <button
                              type="button"
                              className="message-action-btn"
                              title="Copy"
                              onClick={(e) => { e.stopPropagation(); handleCopyMessage(msg); }}
                            >
                              <Copy size={14} />
                            </button>
                          )}
                          {(msg.type === 'image' || msg.type === 'audio' || msg.type === 'gif') && msg.image_url && (
                            <button
                              type="button"
                              className="message-action-btn"
                              title="Download"
                              onClick={(e) => { e.stopPropagation(); handleDownloadMedia(msg); }}
                            >
                              <Download size={14} />
                            </button>
                          )}
                          <button
                            type="button"
                            className="message-action-btn"
                            title="More"
                            onClick={(e) => {
                              e.stopPropagation();
                              const rect = e.currentTarget.getBoundingClientRect();
                              openMessageMenu(msg, rect.left, rect.bottom);
                            }}
                          >
                            ⋮
                          </button>
                        </div>
                      )}
                      <div className="message-time-status" style={{ justifyContent: isSentByMe ? 'flex-end' : 'flex-start' }}>
                        {msg.timestamp ? formatTime(msg.timestamp) : ''}
                        {!msg.group_id && isSentByMe && (
                          <span className={`receipt receipt-${msg.status || 'sent'}`} title={msg.status || 'sent'}>
                            <span className="dot" />
                            <span className="dot dot-2" />
                          </span>
                        )}
                      </div>
                      {Array.isArray(msg.reactions) && msg.reactions.length > 0 && (
                        <div className="reactions-row">
                          {msg.reactions.map(r => (
                            <button
                              key={`${r.emoji}`}
                              type="button"
                              className="reaction-pill"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleToggleReaction(msg.id, r.emoji);
                              }}
                            >
                              <span className="reaction-emoji">{r.emoji}</span>
                              <span className="reaction-count">{r.count}</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
                <div ref={messagesEndRef} />
              </div>
              <div className="chat-input-area">
                {replyTo && (
                  <div className="reply-preview">
                    <div className="reply-preview-left">
                      <div className="reply-preview-title">
                        <ReplyIcon size={14} />
                        <span>Replying to {replyTo.senderUsername || 'message'}</span>
                      </div>
                      <div className="reply-preview-body">
                        {replyTo.type === 'gif' ? '[GIF]' : replyTo.type === 'image' ? (replyTo.content === '[View once photo]' ? '[View once photo]' : '[Image]') : replyTo.type === 'audio' ? '[Voice message]' : (replyTo.content || '')}
                      </div>
                    </div>
                    <button type="button" className="reply-preview-close" onClick={() => setReplyTo(null)} title="Cancel reply">
                      <X size={16} />
                    </button>
                  </div>
                )}
                {(isRecording || recordedAudioUrl) && (
                  <div className="voice-panel">
                    <div className="voice-left">
                      {isRecording ? (
                        <>
                          <span className="rec-dot" />
                          <span className="voice-text">Recording</span>
                          <span className="voice-timer">{formatTimer(recordingSeconds)}</span>
                        </>
                      ) : (
                        <>
                          <span className="voice-text">Voice preview</span>
                          <AudioPlayer src={recordedAudioUrl || ''} />
                        </>
                      )}
                    </div>
                    <div className="voice-actions">
                      <button type="button" className="voice-btn cancel" onClick={cancelRecording}>
                        <X size={16} /> Cancel
                      </button>
                      {isRecording ? (
                        <button type="button" className="voice-btn stop" onClick={stopRecording}>
                          Stop
                        </button>
                      ) : null}
                    </div>
                  </div>
                )}
                {isAnnouncementsReadOnly ? (
                  <div className="message-form" style={{ alignItems: 'center', color: 'var(--text-muted)', fontSize: 13, padding: '10px 14px' }}>
                    Only admins can post in Announcements.
                  </div>
                ) : (
                  <form className="message-form" onSubmit={handleSendMessage}>
                    <button type="button" className="file-upload-btn" onClick={() => fileInputRef.current?.click()} title="Attach image or audio">
                      <ImageIcon size={20} />
                    </button>
                    <input
                      type="file"
                      accept="image/*,audio/*,video/*"
                      style={{ display: 'none' }}
                      ref={fileInputRef}
                      onChange={handleFileUpload}
                    />
                    <textarea
                      ref={messageInputRef}
                      className="message-input"
                      placeholder="Message..."
                      value={newMessage}
                      onChange={handleInputChange}
                      onKeyDown={handleComposerKeyDown}
                      rows={1}
                    />
                    <button
                      type="button"
                      className="file-upload-btn gif-btn"
                      title="Send a GIF"
                      onClick={() => setShowGifPicker(true)}
                    >
                      <Sticker size={19} />
                    </button>
                    <button
                      type="button"
                      className="file-upload-btn"
                      title={isRecording ? 'Stop recording' : 'Start recording'}
                      style={{ color: isRecording ? '#ef4444' : 'var(--text-muted)' }}
                      onClick={() => (isRecording ? stopRecording() : startRecording())}
                      disabled={!!recordedAudioBlob && !recordedAudioUrl}
                    >
                      <Mic size={20} />
                    </button>
                    <button
                      type="submit"
                      className="send-btn"
                      disabled={!newMessage.trim() && !recordedAudioBlob}
                    >
                      <Send size={16} />
                    </button>
                  </form>
                )}
              </div>
            </>
          ) : (
            <div style={{ display: 'flex', height: '100%', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)' }}>
              Select a friend or group to start chatting
            </div>
          )}
        </div>
      </div>
      {messageMenu && (
        <div
          ref={messageMenuRef}
          className="message-menu"
          style={{ left: messageMenu.x, top: messageMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="quick-reactions-bar">
            {QUICK_REACTIONS.map((emoji) => (
              <button
                key={emoji}
                type="button"
                className="quick-emoji-btn"
                onClick={() => {
                  handleToggleReaction(messageMenu.message.id, emoji);
                  setMessageMenu(null);
                }}
              >
                {emoji}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="message-menu-item"
            onClick={() => {
              setReplyTo(buildReplySnapshot(messageMenu.message));
              setMessageMenu(null);
            }}
          >
            <ReplyIcon size={15} />
            <span>Reply</span>
          </button>
          <button
            type="button"
            className="message-menu-item"
            onClick={() => handleCopyMessage(messageMenu.message)}
          >
            <Copy size={15} />
            <span>Copy</span>
          </button>
          {Number(messageMenu.message.sender_id) === Number(user.id) && messageMenu.message.type === 'text' && (
            <button
              type="button"
              className="message-menu-item"
              onClick={() => {
                setEditingMessage(messageMenu.message);
                setEditContent(messageMenu.message.content);
                setMessageMenu(null);
              }}
            >
              <Edit3 size={15} />
              <span>Edit</span>
            </button>
          )}
          <button
            type="button"
            className="message-menu-item"
            onClick={() => {
              setForwardingMessage(messageMenu.message);
              setMessageMenu(null);
            }}
          >
            <Forward size={15} />
            <span>Forward</span>
          </button>
          <button
            type="button"
            className="message-menu-item"
            onClick={() => handleStarMessage(messageMenu.message)}
          >
            <Star size={15} />
            <span>Star</span>
          </button>
          <button
            type="button"
            className="message-menu-item"
            onClick={() => handlePinMessage(messageMenu.message)}
          >
            <Pin size={15} />
            <span>Pin</span>
          </button>
          <button
            type="button"
            className="message-menu-item danger"
            onClick={() => handleDeleteMessage(messageMenu.message, false)}
          >
            <Trash2 size={15} />
            <span>Delete for me</span>
          </button>
          {Number(messageMenu.message.sender_id) === Number(user.id) && (
            <button
              type="button"
              className="message-menu-item danger"
              onClick={() => handleDeleteMessage(messageMenu.message, true)}
            >
              <Trash2 size={15} />
              <span>Delete for everyone</span>
            </button>
          )}
        </div>
      )}
      {quickReactionFor && quickReactionAnchor && (
        <div
          className="quick-reaction-popover"
          style={{ left: quickReactionAnchor.x, top: quickReactionAnchor.y }}
          onClick={(e) => e.stopPropagation()}
        >
          {QUICK_REACTIONS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              className="quick-emoji-btn"
              onClick={() => {
                handleToggleReaction(quickReactionFor, emoji);
                setQuickReactionFor(null);
                setQuickReactionAnchor(null);
              }}
            >
              {emoji}
            </button>
          ))}
        </div>
      )}
      {emojiPickerFor && emojiPickerAnchor && (
        <div
          className="emoji-picker-popover"
          style={{ left: emojiPickerAnchor.x, top: emojiPickerAnchor.y }}
          onMouseEnter={() => { emojiPickerHoverRef.current = true; }}
          onMouseLeave={() => { emojiPickerHoverRef.current = false; setEmojiPickerFor(null); setEmojiPickerAnchor(null); }}
          onClick={(e) => e.stopPropagation()}
        >
          <Suspense fallback={<div style={{ width: 320, height: 380 }} />}>
            <EmojiPicker
              onEmojiClick={(emojiData) => {
                handleToggleReaction(emojiPickerFor, emojiData.emoji);
              }}
              width={320}
              height={380}
              searchDisabled={false}
              skinTonesDisabled={false}
              previewConfig={{ showPreview: false }}
            />
          </Suspense>
        </div>
      )}
      {lightboxUrl && (
        <div
          className="lightbox-overlay"
          onClick={() => setLightboxUrl(null)}
          role="dialog"
          aria-modal="true"
        >
          <button
            type="button"
            className="lightbox-close"
            onClick={(e) => { e.stopPropagation(); setLightboxUrl(null); }}
            aria-label="Close"
            title="Close"
          >
            <X size={22} />
          </button>
          <img
            className="lightbox-image"
            src={lightboxUrl}
            alt="Shared"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
      {pendingImage && (
        <div className="modal-overlay" onClick={cancelPendingImage}>
          <div className="modal-content image-preview-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Send Photo</h3>
              <button type="button" className="close-btn" onClick={cancelPendingImage}>
                <X size={20} />
              </button>
            </div>
            <div className="image-preview-body">
              <img src={pendingImage.previewUrl} alt="Preview" className="image-preview-img" />
            </div>
            <div className="image-preview-mode-toggle">
              <button
                type="button"
                className={`mode-toggle-btn ${!pendingImage.viewOnce ? 'active' : ''}`}
                onClick={() => setPendingImage(prev => prev && { ...prev, viewOnce: false })}
              >
                <ImageIcon size={15} /> Normal
              </button>
              <button
                type="button"
                className={`mode-toggle-btn ${pendingImage.viewOnce ? 'active' : ''}`}
                onClick={() => setPendingImage(prev => prev && { ...prev, viewOnce: true })}
              >
                <Lock size={15} /> View Once
              </button>
            </div>
            {pendingImage.viewOnce && (
              <p className="image-preview-hint">The recipient can open this photo once. It disappears 4 seconds after opening.</p>
            )}
            <div className="modal-actions">
              <button type="button" className="btn-secondary" onClick={cancelPendingImage}>Cancel</button>
              <button type="button" className="btn-primary" onClick={confirmSendPendingImage}>
                <Send size={14} /> Send
              </button>
            </div>
          </div>
        </div>
      )}
      {pendingVideo && (
        <div className="modal-overlay" onClick={cancelPendingVideo}>
          <div className="modal-content video-preview-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Send Video</h3>
              <button type="button" className="close-btn" onClick={cancelPendingVideo}>
                <X size={20} />
              </button>
            </div>
            <div className="video-preview-body">
              <video
                src={pendingVideo.previewUrl}
                controls
                className="video-preview"
              />
            </div>
            <div className="modal-actions">
              <button type="button" className="btn-secondary" onClick={cancelPendingVideo}>Cancel</button>
              <button type="button" className="btn-primary" onClick={confirmSendPendingVideo}>
                <Send size={14} /> Send
              </button>
            </div>
          </div>
        </div>
      )}


      {viewOnceViewer && (
        <div className="lightbox-overlay view-once-overlay" onClick={closeViewOnceViewer} role="dialog" aria-modal="true">
          <button
            type="button"
            className="lightbox-close"
            onClick={(e) => { e.stopPropagation(); closeViewOnceViewer(); }}
            aria-label="Close"
            title="Close"
          >
            <X size={22} />
          </button>
          <img
            className="lightbox-image"
            src={viewOnceViewer.url}
            alt="View once"
            onClick={(e) => e.stopPropagation()}
          />
          <div className="view-once-countdown">This photo will close automatically</div>
        </div>
      )}
      {showGifPicker && (
        <GifPickerModal
          onClose={() => setShowGifPicker(false)}
          onSelect={(gifUrl) => {
            setShowGifPicker(false);
            handleSendMessage(null, { content: '', imageUrl: gifUrl, type: 'gif' });
          }}
        />
      )}
      {editingMessage && (
        <div className="modal-overlay">
          <div className="modal-content" style={{ maxWidth: 450 }}>
            <div className="modal-header">
              <h3>Edit Message</h3>
              <button type="button" className="close-btn" onClick={() => setEditingMessage(null)}><X size={20} /></button>
            </div>
            <div className="form-group" style={{ marginTop: 15 }}>
              <input
                type="text"
                className="form-input"
                value={editContent}
                onChange={(e) => setEditContent(e.target.value)}
                autoFocus
              />
            </div>
            <button type="button" className="btn-primary" onClick={handleEditMessageSubmit}>
              Save Changes
            </button>
          </div>
        </div>
      )}
      {forwardingMessage && (
        <div className="modal-overlay">
          <div className="modal-content" style={{ maxWidth: 450 }}>
            <div className="modal-header">
              <h3>Forward Message</h3>
              <button type="button" className="close-btn" onClick={() => setForwardingMessage(null)}><X size={20} /></button>
            </div>
            <div className="multi-select-list" style={{ marginTop: 15 }}>
              {contacts.concat(groups).map(item => (
                <div
                  key={`${item.is_group ? 'g' : 'c'}_${item.id}`}
                  className="select-item"
                  onClick={() => handleForwardMessageSubmit(item)}
                >
                  <span>{item.name || item.display_name || item.username}</span>
                  <Forward size={16} />
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
      {showFriendRequestsModal && (
        <div className="modal-overlay" onClick={() => setShowFriendRequestsModal(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Friend Requests</h3>
              <button type="button" className="close-btn" onClick={() => setShowFriendRequestsModal(false)}><X size={20} /></button>
            </div>
            {friendRequests.length === 0 ? (
              <div className="empty-state">No pending friend requests.</div>
            ) : (
              <div className="request-list">
                {friendRequests.map(req => (
                  <div key={req.request_id} className="request-item">
                    <div style={{ fontSize: 13, color: 'var(--text-main)', display: 'flex', alignItems: 'center', gap: 6 }}>
                      {req.avatar_url ? (
                        <img src={normalizeMediaUrl(req.avatar_url)} alt="Avatar" className="circular-avatar" style={{ width: 26, height: 26 }} />
                      ) : (
                        <div className="avatar" style={{ width: 26, height: 26, fontSize: 11 }}>{(req.sender_username || '?').charAt(0).toUpperCase()}</div>
                      )}
                      <span><strong style={{ color: 'var(--text-main)' }}>{req.display_name || req.sender_username}</strong> wants to connect</span>
                    </div>
                    <div className="request-actions">
                      <button className="request-btn accept" onClick={() => handleRespondRequest(req.request_id, 'accepted')}><CheckCircle size={14} style={{ display: 'inline', verticalAlign: 'middle', marginRight: 4 }} /> Accept</button>
                      <button className="request-btn reject" onClick={() => handleRespondRequest(req.request_id, 'rejected')}><XCircle size={14} style={{ display: 'inline', verticalAlign: 'middle', marginRight: 4 }} /> Reject</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
      {showGroupModal && (
        <div className="modal-overlay">
          <div className="modal-content">
            <div className="modal-header">
              <h3>Create Group</h3>
              <button type="button" className="close-btn" onClick={() => setShowGroupModal(false)}><X size={20} /></button>
            </div>
            <form onSubmit={handleCreateGroup}>
              <div className="form-group">
                <label>Group Name</label>
                <input
                  type="text"
                  className="form-input"
                  value={newGroupName}
                  onChange={e => setNewGroupName(e.target.value)}
                  placeholder="e.g. Project Team"
                  required
                />
              </div>
              <div className="form-group">
                <label>Group Description</label>
                <input
                  type="text"
                  className="form-input"
                  value={newGroupDesc}
                  onChange={e => setNewGroupDesc(e.target.value)}
                  placeholder="Optional description"
                />
              </div>
              <div className="form-group">
                <label>Select Friends</label>
                <div className="multi-select-list">
                  {contacts.filter(c => !c.is_system).length === 0 ? (
                    <div style={{ padding: 15, fontSize: 13, color: 'var(--text-muted)' }}>No friends added yet.</div>
                  ) : (
                    contacts.filter(c => !c.is_system).map(contact => (
                      <div key={contact.id} className="select-item" onClick={() => toggleContactSelection(contact.id)}>
                        <div style={{ width: '20px', height: '20px', borderRadius: '4px', border: '1px solid var(--border-color)', display: 'flex', alignItems: 'center', justifyContent: 'center', background: selectedContacts.includes(contact.id) ? 'var(--primary)' : 'transparent' }}>
                          {selectedContacts.includes(contact.id) && <Check size={14} color="white" />}
                        </div>
                        <span style={{ fontSize: 14 }}>{contact.display_name || contact.username}</span>
                      </div>
                    ))
                  )}
                </div>
              </div>
              <button type="submit" className="btn-primary" disabled={!newGroupName.trim() || selectedContacts.length === 0}>
                Create Group
              </button>
            </form>
          </div>
        </div>
      )}
      {showProfileModal && (
        <ProfileModal
          user={user}
          setUser={setUser}
          onClose={() => { setShowProfileModal(false); setProfileModalAutoPassword(false); }}
          initialShowPassword={profileModalAutoPassword}
        />
      )}
      {showSettingsModal && (
        <SettingsModal
          user={user}
          onClose={() => setShowSettingsModal(false)}
          settings={userSettings}
          settingsLoading={settingsLoading}
          onSettingsSaved={onSettingsSaved}
          onOpenProfile={(autoPassword) => {
            setShowSettingsModal(false);
            setProfileModalAutoPassword(!!autoPassword);
            setShowProfileModal(true);
          }}
          onLogout={handleLogout}
        />
      )}
      {showStarredModal && (
        <StarredMessagesModal
          user={user}
          onClose={() => setShowStarredModal(false)}
        />
      )}
      {viewingUserId && (
        <UserProfileModal
          userId={viewingUserId}
          isOnline={onlineUserIds.has(Number(viewingUserId))}
          onClose={() => setViewingUserId(null)}
        />
      )}
      {showGroupDetailsModal && activeChat?.is_group && (
        <div className="modal-overlay" onClick={() => setShowGroupDetailsModal(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Group Info</h3>
              <button type="button" className="close-btn" onClick={() => setShowGroupDetailsModal(false)}><X size={20} /></button>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, marginBottom: 16 }}>
              {activeChat.avatar_url ? (
                <img src={normalizeMediaUrl(activeChat.avatar_url)} alt="Group" className="circular-avatar" style={{ width: 64, height: 64 }} />
              ) : (
                <div className="avatar group" style={{ width: 64, height: 64, fontSize: 24 }}><Users size={26} /></div>
              )}
              <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>{groupMembers.length} member{groupMembers.length !== 1 ? 's' : ''}</span>
            </div>
            <div className="form-group">
              <label>Group Name</label>
              <input
                type="text"
                className="form-input"
                value={groupEditName}
                onChange={(e) => setGroupEditName(e.target.value)}
              />
            </div>
            <div className="form-group">
              <label>Description</label>
              <input
                type="text"
                className="form-input"
                value={groupEditDesc}
                onChange={(e) => setGroupEditDesc(e.target.value)}
              />
            </div>
            <div className="form-group">
              <label>Members ({groupMembers.length})</label>
              <div className="multi-select-list">
                {groupMembers.map((m) => (
                  <div key={m.id} className="select-item" style={{ cursor: 'default' }}>
                    <span style={{ fontSize: 14 }}>{m.display_name || m.username}</span>
                    {Number(m.id) !== Number(user.id) && Number(activeChat.created_by) === Number(user.id) && (
                      <button
                        type="button"
                        className="logout-btn"
                        title="Remove member"
                        onClick={async () => {
                          try {
                            await axios.delete(`${API_URL}/groups/${activeChat.id}/members/${m.id}`);
                            setGroupMembers(prev => prev.filter(x => Number(x.id) !== Number(m.id)));
                          } catch (err) {
                            alert(err.response?.data?.error || 'Failed to remove member');
                          }
                        }}
                      >
                        <X size={14} />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
            <button
              type="button"
              className="btn-primary"
              disabled={groupDetailsBusy || !groupEditName.trim()}
              onClick={async () => {
                setGroupDetailsBusy(true);
                try {
                  const res = await axios.put(`${API_URL}/groups/${activeChat.id}`, {
                    name: groupEditName.trim(),
                    description: groupEditDesc
                  });
                  const updated = { ...activeChat, ...res.data, is_group: true };
                  setActiveChat(updated);
                  setGroups(prev => prev.map(g => Number(g.id) === Number(updated.id) ? updated : g));
                  setShowGroupDetailsModal(false);
                } catch (err) {
                  alert(err.response?.data?.error || 'Failed to update group');
                } finally {
                  setGroupDetailsBusy(false);
                }
              }}
            >
              {groupDetailsBusy ? 'Saving...' : 'Save Changes'}
            </button>
            <button
              type="button"
              className="btn-secondary"
              style={{ width: '100%', marginTop: 6 }}
              onClick={() => { setShowGroupDetailsModal(false); setShowSearch(true); }}
            >
              Search Messages
            </button>
            <button
              type="button"
              className="btn-secondary"
              style={{ width: '100%', marginTop: 10 }}
              onClick={async () => {
                if (!confirm('Clear all messages in this chat for you? This cannot be undone.')) return;
                try {
                  const groupMsgIds = messages.filter(m => Number(m.group_id) === Number(activeChat.id)).map(m => m.id);
                  await Promise.all(groupMsgIds.map(id => axios.delete(`${API_URL}/messages/${id}`)));
                  setMessages(prev => prev.filter(m => Number(m.group_id) !== Number(activeChat.id)));
                  setShowGroupDetailsModal(false);
                } catch (err) {
                  alert('Failed to vanish chat');
                }
              }}
            >
              Vanish Chat
            </button>
            {Number(activeChat.created_by) !== Number(user.id) && (
              <button
                type="button"
                className="btn-secondary"
                style={{ width: '100%', marginTop: 10 }}
                onClick={async () => {
                  if (!confirm('Leave this group?')) return;
                  try {
                    await axios.delete(`${API_URL}/groups/${activeChat.id}/members/${user.id}`);
                    setGroups(prev => prev.filter(g => Number(g.id) !== Number(activeChat.id)));
                    setActiveChat(null);
                    setShowGroupDetailsModal(false);
                  } catch (err) {
                    alert(err.response?.data?.error || 'Failed to leave group');
                  }
                }}
              >
                Leave Group
              </button>
            )}
            {Number(activeChat.created_by) === Number(user.id) && (
              <button
                type="button"
                className="btn-secondary"
                style={{ width: '100%', marginTop: 10, color: '#ef4444' }}
                onClick={async () => {
                  if (!confirm('Delete this group for everyone?')) return;
                  try {
                    await axios.delete(`${API_URL}/groups/${activeChat.id}`);
                    setGroups(prev => prev.filter(g => Number(g.id) !== Number(activeChat.id)));
                    setActiveChat(null);
                    setShowGroupDetailsModal(false);
                  } catch (err) {
                    alert(err.response?.data?.error || 'Failed to delete group');
                  }
                }}
              >
                Delete Group
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default ChatDashboard;