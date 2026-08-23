import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { motion, AnimatePresence } from 'framer-motion';
import { Mail, Key, User, ArrowRight, ShieldCheck, CheckCircle2, Eye, EyeOff } from 'lucide-react';
import { API_URL } from '../config';

import { useNavigate } from 'react-router-dom';

const AuthPage = ({ setUser, publicSettings }) => {
  const navigate = useNavigate();
  // Modes: 'check_email' | 'login_password' | 'signup_otp' | 'signup_account' | 'forgot_otp' | 'forgot_password'
  const [mode, setMode] = useState('check_email');

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [username, setUsername] = useState('');
  const [otpCode, setOtpCode] = useState('');
  const [rememberDevice, setRememberDevice] = useState(true);

  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [loading, setLoading] = useState(false);

  // OTP Timer
  const [resendTimer, setResendTimer] = useState(0);

  // Sign-in password show/hide
  const [showPassword, setShowPassword] = useState(false);

  // Forgot password fields
  const [newPassword, setNewPassword] = useState('');
  const [confirmNewPassword, setConfirmNewPassword] = useState('');
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showConfirmNewPassword, setShowConfirmNewPassword] = useState(false);

  useEffect(() => {
    let timer;
    if (resendTimer > 0) {
      timer = setInterval(() => setResendTimer((t) => t - 1), 1000);
    }
    return () => clearInterval(timer);
  }, [resendTimer]);

  const clearMessages = () => {
    setError('');
    setSuccess('');
  };

  // 1. Check Email
  const handleCheckEmail = async (e) => {
    e.preventDefault();
    clearMessages();
    if (!email.trim()) return setError('Please enter your email address');

    setLoading(true);
    try {
      const storedToken = localStorage.getItem('chat_device_token');
      const res = await axios.post(`${API_URL}/auth/check-email`, {
        email,
        deviceToken: storedToken
      });

      if (res.data.exists) {
        setMode('login_password');
      } else {
        setError('No account found with this email. Click Create Account to sign up.');
      }
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to check email');
    } finally {
      setLoading(false);
    }
  };

  // 2. Login with Password
  const handleLogin = async (e) => {
    e.preventDefault();
    clearMessages();
    setLoading(true);

    // ── TEMP DIAGNOSTIC LOGGING — remove once the "Invalid credentials on
    // one device only" issue is confirmed fixed. Never logs the password.
    console.log('[LOGIN DEBUG] Request', {
      url: `${API_URL}/auth/login`,
      method: 'POST',
      fields: { email, rememberDevice, hasDeviceToken: !!localStorage.getItem('chat_device_token') }
    });

    try {
      const storedToken = localStorage.getItem('chat_device_token');
      const res = await axios.post(`${API_URL}/auth/login`, {
        email,
        password,
        rememberDevice,
        deviceToken: storedToken
      }, {
        // Without this, a request that never gets a response (backend
        // unreachable, cold-starting on Render's free tier, blocked by the
        // network) just hangs indefinitely with no feedback — or gets
        // silently killed by an intermediate NAT/proxy after however long
        // that takes, which is indistinguishable from a real credential
        // rejection to the user. Failing fast makes that visibly a
        // *connection* problem instead.
        timeout: 15000
      });

      console.log('[LOGIN DEBUG] Response', { status: res.status, ok: true });

      if (res.data.deviceToken) {
        localStorage.setItem('chat_device_token', res.data.deviceToken);
      }
      localStorage.setItem('chat_user', JSON.stringify(res.data));
      axios.defaults.headers.common['Authorization'] = `Bearer ${res.data.token}`;
      setUser(res.data);
    } catch (err) {
      console.log('[LOGIN DEBUG] Response', {
        status: err.response?.status ?? null,
        body: err.response?.data ?? null,
        // No `err.response` at all means the request never got a reply from
        // the server — wrong/unreachable host, no internet, TLS failure,
        // timeout, DNS failure, etc. That is NOT the same thing as the
        // server rejecting the credentials, and must never be shown as such.
        gotServerResponse: !!err.response,
        errorCode: err.code,
        errorMessage: err.message
      });

      if (err.response?.data?.error) {
        // A real response from the backend — this is an actual credential/
        // account rejection (wrong password, no such account, banned,
        // unverified email, etc). Show exactly what the server said.
        setError(err.response.data.error);
      } else if (err.code === 'ECONNABORTED') {
        setError('The server took too long to respond. It may be waking up — please try again in a moment.');
      } else {
        // No response reached us at all — this is a connectivity problem
        // (device offline, can't reach the backend, DNS/TLS failure), not a
        // wrong password. Previously this showed "Invalid credentials",
        // which is actively misleading here.
        setError('Could not reach the server. Check your internet connection and try again.');
      }
    } finally {
      setLoading(false);
    }
  };

  // 3. Initiate Signup OTP
  const handleStartSignup = async () => {
    clearMessages();
    if (!email.trim()) return setError('Please enter an email address');
    if (publicSettings?.invite_only) {
      return setError('Registrations are currently invite-only. Please contact an administrator.');
    }

    setLoading(true);
    try {
      const res = await axios.post(`${API_URL}/auth/send-otp`, { email, type: 'signup' });
      setSuccess(res.data?.message || 'Verification OTP sent to your email.');
      setMode('signup_otp');
      setResendTimer(30);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to send OTP');
    } finally {
      setLoading(false);
    }
  };

  // 4. Verify Signup OTP
  const handleVerifySignupOTP = async (e) => {
    e.preventDefault();
    clearMessages();
    if (otpCode.length < 6) return setError('Please enter a 6-digit OTP code');

    setLoading(true);
    try {
      await axios.post(`${API_URL}/auth/verify-otp`, { email, otpCode, type: 'signup' });
      setSuccess('Email verified! Choose your username and password.');
      setMode('signup_account');
    } catch (err) {
      setError(err.response?.data?.error || 'Invalid OTP code');
    } finally {
      setLoading(false);
    }
  };

  // 5. Complete Registration
  const handleCompleteRegister = async (e) => {
    e.preventDefault();
    clearMessages();
    if (!username.trim()) return setError('Please choose a username');
    if (password.length < 6) return setError('Password must be at least 6 characters');
    setLoading(true);

    try {
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
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to create account');
    } finally {
      setLoading(false);
    }
  };

  // 6. Forgot Password - Send OTP
  const handleStartForgotPassword = async () => {
    clearMessages();
    if (!email.trim()) return setError('Please enter your email address first');

    setLoading(true);
    try {
      const res = await axios.post(`${API_URL}/auth/forgot-password/send-otp`, { email });
      setSuccess(res.data?.message || 'Reset OTP sent to your email.');
      setMode('forgot_otp');
      setResendTimer(30);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to send reset OTP');
    } finally {
      setLoading(false);
    }
  };

  // 7. Forgot Password - Reset
  const handleResetPassword = async (e) => {
    e.preventDefault();
    clearMessages();
    if (newPassword.length < 6) return setError('Password must be at least 6 characters');
    if (newPassword !== confirmNewPassword) return setError('Passwords do not match');
    setLoading(true);

    try {
      await axios.post(`${API_URL}/auth/forgot-password/reset`, {
        email,
        otpCode,
        newPassword
      });
      setSuccess('Password reset successfully! Redirecting to Sign in...');
      // Clear fields and go back to login
      setPassword('');
      setNewPassword('');
      setConfirmNewPassword('');
      setOtpCode('');
      // After a short delay, show the login password view
      setTimeout(() => {
        setMode('login_password');
      }, 800);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to reset password');
    } finally {
      setLoading(false);
    }
  };

  const handleResendOTP = async (type = 'signup') => {
    if (resendTimer > 0) return;
    clearMessages();
    try {
      const endpoint = type === 'signup' ? '/auth/send-otp' : '/auth/forgot-password/send-otp';
      await axios.post(`${API_URL}${endpoint}`, { email, type });
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
          <h1>Sign in</h1>
          <p>{'Welcome to Aerio'}</p>
        </div>

        {error && <div className="error-text">{error}</div>}
        {success && <div className="success-text">{success}</div>}

        <AnimatePresence mode="wait">
          {/* STEP 1: EMAIL ENTRY */}
          {mode === 'check_email' && (
            <motion.form 
              key="check_email"
              initial={{ opacity: 0, x: -15 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 15 }}
              onSubmit={handleLogin}
            >
              <div className="form-group">
                <label><Mail size={14} /> Username or Email</label>
                <input 
                  type="text" 
                  className="form-input"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="username or name@domain.com"
                  required
                  autoFocus
                />
              </div>

              <div className="form-group" style={{ position: 'relative' }}>
                <label><Key size={14} /> Password</label>
                <div style={{ position: 'relative' }}>
                  <input
                    type={showPassword ? 'text' : 'password'}
                    className="form-input"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Enter your password"
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

              <div className="form-options">
                <label className="remember-checkbox">
                  <input 
                    type="checkbox" 
                    checked={rememberDevice}
                    onChange={(e) => setRememberDevice(e.target.checked)}
                  />
                  <span>Remember this device</span>
                </label>

                <button type="button" className="forgot-link" onClick={handleStartForgotPassword}>
                  Forgot Password?
                </button>
              </div>

              <button type="submit" className="btn-primary" disabled={loading}>
                {loading ? 'Signing In...' : 'Sign In'}
              </button>

              <div className="auth-switch" style={{ marginTop: 20 }}>
                Don't have an account?{' '}
                <span onClick={() => navigate('/signup')} style={{ cursor: 'pointer' }}>
                  Create Account
                </span>
              </div>
            </motion.form>
          )}

          {/* STEP 2: LOGIN WITH PASSWORD */}
          {mode === 'login_password' && (
            <motion.form 
              key="login_password"
              initial={{ opacity: 0, x: 15 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -15 }}
              onSubmit={handleLogin}
            >
              <div className="auth-user-badge">
                <Mail size={14} /> {email}
                <button type="button" onClick={() => { setMode('check_email'); clearMessages(); }} className="badge-change">
                  Change
                </button>
              </div>

              <div className="form-group">
                <label><Key size={14} /> Password</label>
                <input 
                  type="password" 
                  className="form-input"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter your password"
                  required
                  autoFocus
                />
              </div>

              <div className="form-options">
                <label className="remember-checkbox">
                  <input 
                    type="checkbox" 
                    checked={rememberDevice}
                    onChange={(e) => setRememberDevice(e.target.checked)}
                  />
                  <span>Remember this device</span>
                </label>

                <button type="button" className="forgot-link" onClick={handleStartForgotPassword}>
                  Forgot Password?
                </button>
              </div>

              <button type="submit" className="btn-primary" disabled={loading}>
                {loading ? 'Signing In...' : 'Sign In'}
              </button>
            </motion.form>
          )}

          {/* STEP 3: SIGNUP OTP VERIFICATION */}
          {mode === 'signup_otp' && (
            <motion.form 
              key="signup_otp"
              initial={{ opacity: 0, x: 15 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -15 }}
              onSubmit={handleVerifySignupOTP}
            >
              <div className="auth-user-badge">
                <Mail size={14} /> {email}
                <button type="button" onClick={() => { setMode('check_email'); clearMessages(); }} className="badge-change">
                  Change
                </button>
              </div>

              <div className="form-group">
                <label><ShieldCheck size={14} /> 6-Digit Email Verification Code</label>
                <input 
                  type="text" 
                  className="form-input"
                  maxLength={6}
                  value={otpCode}
                  onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, ''))}
                  placeholder="123456"
                  required
                  autoFocus
                  style={{ letterSpacing: '4px', fontSize: '18px', textAlign: 'center' }}
                />
              </div>

              <button type="submit" className="btn-primary" disabled={loading || otpCode.length < 6}>
                {loading ? 'Verifying...' : 'Verify OTP'}
              </button>

              <div className="auth-switch" style={{ marginTop: 15 }}>
                {resendTimer > 0 ? (
                  <span style={{ color: 'var(--text-muted)' }}>Resend OTP in {resendTimer}s</span>
                ) : (
                  <span onClick={() => handleResendOTP('signup')}>Resend OTP</span>
                )}
              </div>
            </motion.form>
          )}

          {/* STEP 4: SIGNUP ACCOUNT DETAILS */}
          {mode === 'signup_account' && (
            <motion.form 
              key="signup_account"
              initial={{ opacity: 0, x: 15 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -15 }}
              onSubmit={handleCompleteRegister}
            >
              <div className="success-badge">
                <CheckCircle2 size={14} /> Email Verified: {email}
              </div>

              <div className="form-group">
                <label><User size={14} /> Choose Username</label>
                <input 
                  type="text" 
                  className="form-input"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="e.g. maaz_khan"
                  required
                  autoFocus
                />
              </div>

              <div className="form-group">
                <label><Key size={14} /> Choose Password</label>
                <input 
                  type="password" 
                  className="form-input"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Minimum 6 characters"
                  required
                />
              </div>

              <label className="remember-checkbox" style={{ marginBottom: 15 }}>
                <input 
                  type="checkbox" 
                  checked={rememberDevice}
                  onChange={(e) => setRememberDevice(e.target.checked)}
                />
                <span>Remember this device</span>
              </label>

              <button type="submit" className="btn-primary" disabled={loading}>
                {loading ? 'Creating Account...' : 'Complete & Sign In'}
              </button>
            </motion.form>
          )}

          {/* FORGOT PASSWORD - OTP */}
          {mode === 'forgot_otp' && (
            <motion.form 
              key="forgot_otp"
              initial={{ opacity: 0, x: 15 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -15 }}
              onSubmit={(e) => {
                e.preventDefault();
                setMode('forgot_password');
              }}
            >
              <div className="auth-user-badge">
                <Mail size={14} /> Resetting: {email}
              </div>

              <div className="form-group">
                <label><ShieldCheck size={14} /> Enter Reset OTP</label>
                <input 
                  type="text" 
                  className="form-input"
                  maxLength={6}
                  value={otpCode}
                  onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, ''))}
                  placeholder="123456"
                  required
                  autoFocus
                  style={{ letterSpacing: '4px', fontSize: '18px', textAlign: 'center' }}
                />
              </div>

              <button type="submit" className="btn-primary" disabled={loading || otpCode.length < 6}>
                Next <ArrowRight size={16} />
              </button>

              <div className="auth-switch" style={{ marginTop: 15 }}>
                {resendTimer > 0 ? (
                  <span style={{ color: 'var(--text-muted)' }}>Resend OTP in {resendTimer}s</span>
                ) : (
                  <span onClick={() => handleResendOTP('reset')}>Resend OTP</span>
                )}
              </div>
            </motion.form>
          )}

          {/* FORGOT PASSWORD - NEW PASSWORD */}
          {mode === 'forgot_password' && (
            <motion.form 
              key="forgot_password"
              initial={{ opacity: 0, x: 15 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -15 }}
              onSubmit={handleResetPassword}
            >
              <div className="form-group" style={{ position: 'relative' }}>
                <label><Key size={14} /> New Password</label>
                <div style={{ position: 'relative' }}>
                  <input 
                    type={showNewPassword ? 'text' : 'password'}
                    className="form-input"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder="New password"
                    required
                    autoFocus
                  />
                  <button
                    type="button"
                    onClick={() => setShowNewPassword(s => !s)}
                    style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}
                    aria-label={showNewPassword ? 'Hide password' : 'Show password'}
                  >
                    {showNewPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
              </div>

              <div className="form-group" style={{ position: 'relative' }}>
                <label><Key size={14} /> Confirm New Password</label>
                <div style={{ position: 'relative' }}>
                  <input 
                    type={showConfirmNewPassword ? 'text' : 'password'}
                    className="form-input"
                    value={confirmNewPassword}
                    onChange={(e) => setConfirmNewPassword(e.target.value)}
                    placeholder="Re-enter new password"
                    required
                  />
                  <button
                    type="button"
                    onClick={() => setShowConfirmNewPassword(s => !s)}
                    style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}
                    aria-label={showConfirmNewPassword ? 'Hide password' : 'Show password'}
                  >
                    {showConfirmNewPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
              </div>

              {newPassword && confirmNewPassword && newPassword !== confirmNewPassword && (
                <div className="error-text">Passwords do not match</div>
              )}

              <button type="submit" className="btn-primary" disabled={loading || newPassword.length < 6 || newPassword !== confirmNewPassword}>
                {loading ? 'Resetting...' : 'Reset Password & Sign In'}
              </button>
            </motion.form>
          )}
        </AnimatePresence>

        <div style={{ marginTop: '30px', textAlign: 'center', fontSize: '12px', color: 'var(--text-muted)' }}>
          Created by Maaz
        </div>
      </div>
    </div>
  );
};

export default AuthPage;