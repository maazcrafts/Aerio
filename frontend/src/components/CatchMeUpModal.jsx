import React from 'react';
import { motion } from 'framer-motion';
import { X, Clock } from 'lucide-react';

// Compact panel listing every conversation that currently has 3+ unread
// messages, with an on-demand summary of just the unread portion of each.
const CatchMeUpModal = ({ items, summaries, onLoadSummary, onClose }) => {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <motion.div
        className="modal-content catch-up-modal"
        initial={{ opacity: 0, scale: 0.95, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 10 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Clock size={17} color="var(--primary)" />
            <h3>Catch me up</h3>
          </div>
          <button type="button" className="close-btn" onClick={onClose} aria-label="Close">
            <X size={20} />
          </button>
        </div>

        {items.length === 0 ? (
          <div className="catch-up-empty">
            <p className="catch-up-empty-title">You're all caught up</p>
            <p className="catch-up-empty-sub">No conversations currently have 3 or more unread messages.</p>
          </div>
        ) : (
          <>
            <p className="catch-up-subtitle">
              You have unread activity in {items.length} conversation{items.length === 1 ? '' : 's'}
            </p>
            <div className="catch-up-list">
              {items.map((item) => {
                const summary = summaries[item.key];
                return (
                  <div key={item.key} className="catch-up-item">
                    <div className="catch-up-item-header">
                      <span className="catch-up-item-name">{item.name}</span>
                      <span className="catch-up-item-count">
                        {item.count} unread message{item.count === 1 ? '' : 's'}
                      </span>
                    </div>

                    {!summary ? (
                      <button
                        type="button"
                        className="catch-up-view-btn"
                        onClick={() => onLoadSummary(item)}
                      >
                        View summary →
                      </button>
                    ) : summary.status === 'loading' ? (
                      <div className="catch-up-summary-text catch-up-summary-loading">
                        Summarizing unread messages...
                      </div>
                    ) : summary.status === 'error' ? (
                      <div className="catch-up-summary-text catch-up-summary-error">
                        Couldn't load the summary.{' '}
                        <button type="button" className="catch-up-retry-btn" onClick={() => onLoadSummary(item)}>
                          Retry
                        </button>
                      </div>
                    ) : (
                      <div className="catch-up-summary-text">{summary.text}</div>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}

        <div className="catch-up-footer">
          <button type="button" className="btn-primary btn-small" onClick={onClose}>
            Done
          </button>
        </div>
      </motion.div>
    </div>
  );
};

export default CatchMeUpModal;