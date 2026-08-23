import React, { useEffect, useRef, useState } from 'react';
import axios from 'axios';
import { motion } from 'framer-motion';
import { X, Search, Loader2 } from 'lucide-react';
import { API_URL } from '../config';

// Search/browse GIFs (via the backend's Tenor proxy) and send one as a chat
// message. If the server hasn't been configured with a KLIPY_API_KEY, the
// backend returns a 501 with a clear message, which we surface here instead
// of silently failing.
const GifPickerModal = ({ onClose, onSelect }) => {
  const [query, setQuery] = useState('');
  const [gifs, setGifs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notConfigured, setNotConfigured] = useState(false);
  const debounceRef = useRef(null);

  const fetchGifs = async (q) => {
    setLoading(true);
    setError('');
    try {
      const endpoint = q ? `${API_URL}/gif/search` : `${API_URL}/gif/trending`;
      const res = await axios.get(endpoint, { params: q ? { q, limit: 30 } : { limit: 30 } });
      setGifs(res.data?.results || []);
    } catch (err) {
      if (err.response?.status === 501) {
        setNotConfigured(true);
        setError(err.response.data?.error || 'GIF search is not configured.');
      } else {
        setError('Failed to load GIFs. Please try again.');
      }
      setGifs([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchGifs('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      fetchGifs(query.trim());
    }, 400);
    return () => clearTimeout(debounceRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <motion.div
        className="modal-content gif-picker-modal"
        initial={{ opacity: 0, scale: 0.95, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 10 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h3>Send a GIF</h3>
          <button type="button" className="close-btn" onClick={onClose}>
            <X size={20} />
          </button>
        </div>

        {!notConfigured && (
          <div className="gif-search-bar">
            <Search size={16} />
            <input
              type="text"
              autoFocus
              placeholder="Search GIFs..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        )}

        <div className="gif-grid-container">
          {loading ? (
            <div className="empty-state"><Loader2 size={20} className="spin" /> Loading GIFs...</div>
          ) : notConfigured ? (
            <div className="empty-state" style={{ padding: '24px 16px', textAlign: 'center' }}>
              GIF search isn't set up yet.<br />
              Add a <code>KLIPY_API_KEY</code> to the backend's <code>.env</code> file to enable it.
            </div>
          ) : error ? (
            <div className="empty-state">{error}</div>
          ) : gifs.length === 0 ? (
            <div className="empty-state">No GIFs found.</div>
          ) : (
            <div className="gif-grid">
              {gifs.map((g) => (
                <button
                  key={g.id}
                  type="button"
                  className="gif-grid-item"
                  onClick={() => onSelect(g.url)}
                  title={g.title || 'GIF'}
                >
                  <img src={g.preview_url || g.url} alt={g.title || 'GIF'} loading="lazy" />
                </button>
              ))}
            </div>
          )}
        </div>
      </motion.div>
    </div>
  );
};

export default GifPickerModal;