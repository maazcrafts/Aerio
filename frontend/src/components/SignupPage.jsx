import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { motion } from 'framer-motion';
import { Mail, ShieldCheck, User, Key, ArrowRight, CheckCircle2, Eye, EyeOff } from 'lucide-react';
import { API_URL } from '../config';
import { useNavigate } from 'react-router-dom';

const SignupPage = ({ setUser, publicSettings }) => {
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [otpCode, setOtpCode] = useState('');
  const [rememberDevice, setRememberDevice] = useState(true);

  const [mode, setMode] = useState('enter_email'); // enter_email | otp | account
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [loading, setLoading] = useState(false);

  // OTP Timer
  const [resendTimer, setResendTimer] = useState(0);
  useEffect(() => {
    let timer;
    if (resendTimer > 0) {
      timer = setInterval(() => setResendTimer((t) => t - 1), 1000);
    }
    return () => clearInterval(timer);
  }, [resendTimer]);

  const clearMessages = () => { setError(''); setSuccess(''); };
  const navigate = useNavigate();

  const handleSendOTP = async (e) => {
    if (e) e.preventDefault();
    clearMessages();
    if (!email.trim()) return setError('Please enter an email address');
    if (publicSettings?.invite_only) return setError('Registrations are currently invite-only. Please contact an administrator.');
    setLoading(true);

    try {
      const res = await axios.post(`${API_URL}/auth/send-otp`, { email, type: 'signup' });
      setSuccess(res.data?.message || 'Verification OTP sent to your email.');
      setMode('otp');
      setResendTimer(30);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to send OTP');
    } finally {
      setLoading(false);
    }
  };

  const handleVerifyOTP = async (e) => {
    if (e) e.preventDefault();
    clearMessages();
    if (otpCode.length < 6) return setError('Please enter a 6-digit OTP code');
    setLoading(true);
    try {
      await axios.post(`${API_URL}/auth/verify-otp`, { email, otpCode, type: 'signup' });
      setSuccess('Email verified! Choose your username and password.');
      setMode('account');
    } catch (err) {
      setError(err.response?.data?.error || 'Invalid OTP code');
    } finally {
      setLoading(false);
    }
  };

  const handleCompleteRegister = async (e) => {
    if (e) e.preventDefault();
    clearMessages();
    if (!username.trim()) return setError('Please choose a username');
    if (password.length < 6) return setError('Password must be at least 6 characters');
    setLoading(true);

    try {
      if (password !== confirmPassword) {
        setError('Passwords do not match');
        setLoading(false);
        return;
      }

      const res = await axios.post(`${API_URL}/auth/register-complete`, {
        email,
        username,
        password,
        rememberDevice
      });

      if (res.data.deviceToken) {
        localStorage.setItem('chat_device_token', res.data.deviceToken);
      }
      localStorage.setItem('chat_user', JSON.stringify(res.data));
      axios.defaults.headers.common['Authorization'] = `Bearer ${res.data.token}`;
      setUser(res.data);
      navigate('/chat');
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to create account');
    } finally {
      setLoading(false);
    }
  };

  const handleResend = async () => {
    if (resendTimer > 0) return;
    clearMessages();
    try {
      await axios.post(`${API_URL}/auth/send-otp`, { email, type: 'signup' });
      setSuccess('A new OTP has been sent to your email.');
      setResendTimer(30);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to resend OTP');
    }
  };

  return (
    <div className="app-container">
      <div className="auth-card">
        <div className="auth-header">
          <h1>Create Account</h1>
          <p>Join and start chatting — simple, fast.</p>
        </div>

        {error && <div className="error-text">{error}</div>}
        {success && <div className="success-text">{success}</div>}

        {mode === 'enter_email' && (
          <motion.form onSubmit={handleSendOTP} initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
            <div className="form-group">
              <label><Mail size={14} /> Email Address</label>
              <input type="email" className="form-input" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@domain.com" required autoFocus />
            </div>
            <button type="submit" className="btn-primary" disabled={loading}>{loading ? 'Sending...' : 'Send Verification Code'}</button>
            <div className="auth-switch" style={{ marginTop: 20 }}>
              Already have an account? <span onClick={() => navigate('/')} style={{ cursor: 'pointer' }}>Sign in</span>
            </div>
          </motion.form>
        )}

        {mode === 'otp' && (
          <motion.form onSubmit={handleVerifyOTP} initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
            <div className="auth-user-badge">
              <Mail size={14} /> {email}
              <button type="button" onClick={() => { setMode('enter_email'); clearMessages(); }} className="badge-change">Change</button>
            </div>

            <div className="form-group">
              <label><ShieldCheck size={14} /> 6-Digit Email Verification Code</label>
              <input type="text" className="form-input" maxLength={6} value={otpCode} onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, ''))} placeholder="123456" required autoFocus style={{ letterSpacing: '4px', fontSize: '18px', textAlign: 'center' }} />
            </div>

            <button type="submit" className="btn-primary" disabled={loading || otpCode.length < 6}>{loading ? 'Verifying...' : 'Verify OTP'}</button>

            <div className="auth-switch" style={{ marginTop: 15 }}>
              {resendTimer > 0 ? (<span style={{ color: 'var(--text-muted)' }}>Resend OTP in {resendTimer}s</span>) : (<span onClick={handleResend} style={{ cursor: 'pointer' }}>Resend OTP</span>)}
            </div>
          </motion.form>
        )}

        {mode === 'account' && (
          <motion.form onSubmit={handleCompleteRegister} initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
            <div className="success-badge"><CheckCircle2 size={14} /> Email Verified: {email}</div>

            <div className="form-group">
              <label><User size={14} /> Choose Username</label>
              <input type="text" className="form-input" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="e.g. maaz_khan" required autoFocus />
            </div>

            <div className="form-group" style={{ position: 'relative' }}>
              <label><Key size={14} /> Choose Password</label>
              <div style={{ position: 'relative' }}>
                <input
                  type={showPassword ? 'text' : 'password'}
                  className="form-input"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Minimum 6 characters"
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(s => !s)}
                  style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                >
                  {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>

            <div className="form-group" style={{ position: 'relative' }}>
              <label><Key size={14} /> Confirm Password</label>
              <div style={{ position: 'relative' }}>
                <input
                  type={showConfirmPassword ? 'text' : 'password'}
                  className="form-input"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="Re-enter password"
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowConfirmPassword(s => !s)}
                  style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}
                  aria-label={showConfirmPassword ? 'Hide password' : 'Show password'}
                >
                  {showConfirmPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>

            {password && confirmPassword && password !== confirmPassword && (
              <div className="error-text">Passwords do not match</div>
            )}

            <label className="remember-checkbox" style={{ marginBottom: 15 }}>
              <input type="checkbox" checked={rememberDevice} onChange={(e) => setRememberDevice(e.target.checked)} />
              <span>Remember this device</span>
            </label>

            <button type="submit" className="btn-primary" disabled={loading || password.length < 6 || password !== confirmPassword}>{loading ? 'Creating Account...' : 'Complete & Sign In'}</button>

            <div className="auth-switch" style={{ marginTop: 15 }}>
              Already have an account? <span onClick={() => navigate('/')} style={{ cursor: 'pointer' }}>Sign in</span>
            </div>
          </motion.form>
        )}

        <div style={{ marginTop: '30px', textAlign: 'center', fontSize: '12px', color: 'var(--text-muted)' }}>Created by Maaz</div>
      </div>
    </div>
  );
};

export default SignupPage;
