import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { motion } from 'framer-motion';
import { X, Star } from 'lucide-react';
import { API_URL } from '../config';

const StarredMessagesModal = ({ user, onClose }) => {
  const [starredMessages, setStarredMessages] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchStarred = async () => {
      try {
        const res = await axios.get(`${API_URL}/messages/starred/${user.id}`);
        setStarredMessages(res.data || []);
      } catch (_) {}
      setLoading(false);
    };
    fetchStarred();
  }, [user.id]);

  const handleUnstar = async (messageId) => {
    try {
      await axios.post(`${API_URL}/messages/${messageId}/star`);
      setStarredMessages(prev => prev.filter(m => m.id !== messageId));
    } catch (_) {}
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <motion.div 
        className="modal-content starred-modal"
        initial={{ opacity: 0, scale: 0.95, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 10 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Star size={20} color="#f59e0b" fill="#f59e0b" />
            <h3>Starred Messages</h3>
          </div>
          <button type="button" className="close-btn" onClick={onClose}>
            <X size={20} />
          </button>
        </div>

        <div className="starred-body">
          {loading ? (
            <div className="empty-state">Loading starred messages...</div>
          ) : starredMessages.length === 0 ? (
            <div className="empty-state">No starred messages yet. Star a message by right-clicking it.</div>
          ) : (
            <div className="starred-list">
              {starredMessages.map((msg) => (
                <div key={msg.id} className="starred-item">
                  <div className="starred-item-header">
                    <span className="starred-sender">{msg.sender_username || 'Unknown'}</span>
                    <span className="starred-date">{new Date(msg.starred_at || msg.timestamp).toLocaleDateString()}</span>
                  </div>
                  <div className="starred-item-body">
                    {msg.type === 'image' ? '[Image]' : msg.type === 'audio' ? '[Voice Message]' : msg.content}
                  </div>
                  <button 
                    type="button"
                    className="unstar-btn"
                    onClick={() => handleUnstar(msg.id)}
                    title="Remove Star"
                  >
                    Unstar
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </motion.div>
    </div>
  );
};

export default StarredMessagesModal;
