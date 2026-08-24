import React from 'react';

const MaintenancePage = ({ message }) => {
  return (
    <div className="app-container">
      <div className="auth-card" style={{ maxWidth: 520 }}>
        <div className="auth-header">
          <h1>Aerio</h1>
          <p>We’ll be back soon</p>
        </div>
        <div style={{ color: 'var(--text-muted)', fontSize: 14, lineHeight: 1.5 }}>
          {message || 'The app is currently under maintenance. Please try again later.'}
        </div>
      </div>
    </div>
  );
};

export default MaintenancePage;

