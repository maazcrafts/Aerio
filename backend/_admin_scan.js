const http = require('http');
const db = require('./database');
const { io } = require('socket.io-client');

function req(method, pathName, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    if (data) headers['Content-Length'] = Buffer.byteLength(data);
    const r = http.request({ hostname: 'localhost', port: 3000, path: pathName, method, headers }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => {
        let parsed = b;
        try { parsed = JSON.parse(b); } catch (_) {}
        resolve({ status: res.statusCode, data: parsed });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

async function signup(prefix) {
  const email = `${prefix}_${Date.now()}@example.com`;
  const username = `${prefix}_${Date.now()}`;
  await req('POST', '/api/auth/send-otp', { email, type: 'signup' });
  const otp = (await db.query('SELECT otp_code FROM otps WHERE email=$1 ORDER BY id DESC LIMIT 1', [email])).rows[0].otp_code;
  await req('POST', '/api/auth/verify-otp', { email, otpCode: otp, type: 'signup' });
  const r = await req('POST', '/api/auth/register-complete', { email, username, password: 'test1234' });
  return { email, username, id: r.data.id, token: r.data.token };
}

(async () => {
  let fails = 0;
  const check = (name, pass, detail) => {
    console.log(`${pass ? 'PASS' : 'FAIL'} | ${name}${detail ? ' — ' + detail : ''}`);
    if (!pass) fails++;
  };

  // OTP invalidation: old code must fail after resend
  const email = `otpinv_${Date.now()}@example.com`;
  await req('POST', '/api/auth/send-otp', { email, type: 'signup' });
  const oldOtp = (await db.query('SELECT otp_code FROM otps WHERE email=$1 ORDER BY id DESC LIMIT 1', [email])).rows[0].otp_code;
  await req('POST', '/api/auth/send-otp', { email, type: 'signup' });
  const newOtp = (await db.query('SELECT otp_code FROM otps WHERE email=$1 ORDER BY id DESC LIMIT 1', [email])).rows[0].otp_code;
  const oldTry = await req('POST', '/api/auth/verify-otp', { email, otpCode: oldOtp, type: 'signup' });
  check('old otp rejected after resend', oldTry.status === 400, JSON.stringify(oldTry.data));
  const newTry = await req('POST', '/api/auth/verify-otp', { email, otpCode: newOtp, type: 'signup' });
  check('new otp accepted', newTry.status === 200 && newTry.data.verified);

  // Ban blocks API + socket
  const victim = await signup('banme');
  const okSettings = await req('GET', '/api/settings/user', null, victim.token);
  check('pre-ban api works', okSettings.status === 200);

  // promote a scanner to admin via DB for admin API tests
  const admin = await signup('adminish');
  await db.query("UPDATE users SET role='admin', username='maaz_khan_test_admin' WHERE id=$1", [admin.id]);
  // re-login won't change role in token - need new token. Sign JWT by logging in after role update:
  // username changed so login with email
  const loginAdmin = await req('POST', '/api/auth/login', { email: admin.email, password: 'test1234' });
  check('admin login after role elevate', loginAdmin.status === 200 && loginAdmin.data.role === 'admin');
  const adminToken = loginAdmin.data.token;

  const ban = await req('POST', `/api/admin/dashboard/users/${victim.id}/ban`, { banned: true }, adminToken);
  check('ban user', ban.status === 200);

  const bannedApi = await req('GET', '/api/settings/user', null, victim.token);
  check('banned token blocked on api', bannedApi.status === 403, JSON.stringify(bannedApi.data));

  const sock = io('http://localhost:3000', { auth: { token: victim.token } });
  const sockResult = await new Promise((resolve) => {
    const t = setTimeout(() => resolve('timeout'), 3000);
    sock.on('connect', () => { clearTimeout(t); resolve('connected'); });
    sock.on('connect_error', () => { clearTimeout(t); resolve('rejected'); });
  });
  sock.close();
  check('banned socket rejected', sockResult === 'rejected', sockResult);

  // Admin dashboard endpoints
  const stats = await req('GET', '/api/admin/dashboard/stats', null, adminToken);
  check('admin stats', stats.status === 200 && stats.data.totals);
  const users = await req('GET', '/api/admin/dashboard/users', null, adminToken);
  check('admin users', users.status === 200 && Array.isArray(users.data));
  const msgs = await req('GET', '/api/admin/dashboard/messages?limit=10', null, adminToken);
  check('admin messages', msgs.status === 200 && Array.isArray(msgs.data));
  const aset = await req('GET', '/api/admin/dashboard/settings', null, adminToken);
  check('admin settings get', aset.status === 200);
  const asave = await req('PUT', '/api/admin/dashboard/settings', {
    maintenance_mode: false,
    invite_only: false,
    welcome_message: aset.data.welcome_message || 'Welcome to Aerio'
  }, adminToken);
  check('admin settings save', asave.status === 200);

  const broadcast = await req('POST', '/api/admin/dashboard/broadcast', { content: 'Scan broadcast ' + Date.now() }, adminToken);
  check('admin broadcast', broadcast.status === 200 && broadcast.data.ok);

  // unban
  await req('POST', `/api/admin/dashboard/users/${victim.id}/ban`, { banned: false }, adminToken);

  // empty broadcast rejected
  const emptyB = await req('POST', '/api/admin/dashboard/broadcast', { content: '  ' }, adminToken);
  check('empty broadcast rejected', emptyB.status === 400);

  console.log(`\nFails: ${fails}`);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
