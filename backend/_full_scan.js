const http = require('http');
const fs = require('fs');
const path = require('path');
const db = require('./database');
const { io } = require('socket.io-client');

const results = [];
function ok(name, pass, detail) {
  results.push({ name, pass: !!pass, detail: detail || '' });
  console.log(`${pass ? 'PASS' : 'FAIL'} | ${name}${detail ? ' — ' + detail : ''}`);
}

function req(method, pathName, body, token, isForm) {
  return new Promise((resolve, reject) => {
    let data = null;
    const headers = {};
    if (token) headers.Authorization = 'Bearer ' + token;
    if (body && !isForm) {
      data = JSON.stringify(body);
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(data);
    }
    const r = http.request({ hostname: 'localhost', port: 3000, path: pathName, method, headers }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => {
        let parsed = b;
        try { parsed = JSON.parse(b); } catch (_) {}
        resolve({ status: res.statusCode, data: parsed, headers: res.headers });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

async function signup(label) {
  const email = `${label}_${Date.now()}@example.com`;
  const username = `${label}_${Date.now()}`;
  await req('POST', '/api/auth/send-otp', { email, type: 'signup' });
  const otp = (await db.query('SELECT otp_code FROM otps WHERE email=$1 ORDER BY id DESC LIMIT 1', [email])).rows[0].otp_code;
  await req('POST', '/api/auth/verify-otp', { email, otpCode: otp, type: 'signup' });
  const r = await req('POST', '/api/auth/register-complete', { email, username, password: 'test1234', rememberDevice: true });
  return { email, username, ...r.data, token: r.data.token };
}

(async () => {
  // Health
  let r = await req('GET', '/health');
  ok('GET /health', r.status === 200 && r.data === 'ok', r.status);
  r = await req('GET', '/api/health');
  ok('GET /api/health', r.status === 200 && r.data.ok, r.status);

  // Public settings
  r = await req('GET', '/api/settings/public');
  ok('GET /api/settings/public', r.status === 200 && typeof r.data.maintenance_mode === 'boolean');

  // Auth negative
  r = await req('POST', '/api/auth/check-email', {});
  ok('check-email missing', r.status === 400);
  r = await req('POST', '/api/auth/register-complete', { email: 'a@b.com', username: 'x', password: '123456' });
  ok('register without otp', r.status === 403);
  r = await req('POST', '/api/auth/login', { email: 'nope@example.com', password: 'x' });
  ok('login missing user', r.status === 400);

  // Signup users
  const u1 = await signup('scan1');
  const u2 = await signup('scan2');
  ok('signup u1', !!u1.token && !!u1.id);
  ok('signup u2', !!u2.token && !!u2.id);
  ok('deviceToken on signup', !!u1.deviceToken);

  // check-email exists
  r = await req('POST', '/api/auth/check-email', { email: u1.email, deviceToken: u1.deviceToken });
  ok('check-email exists+trusted', r.status === 200 && r.data.exists && r.data.isDeviceTrusted);

  // login
  r = await req('POST', '/api/auth/login', { email: u1.email, password: 'test1234' });
  ok('login', r.status === 200 && r.data.token);
  u1.token = r.data.token;

  // bad token
  r = await req('GET', '/api/settings/user', null, 'bad.token.here');
  ok('bad jwt rejected', r.status === 403 || r.status === 401);

  // forgot password
  r = await req('POST', '/api/auth/forgot-password/send-otp', { email: u1.email });
  ok('forgot send otp', r.status === 200 && r.data.ok);
  const fotp = (await db.query("SELECT otp_code FROM otps WHERE email=$1 AND type='reset_password' ORDER BY id DESC LIMIT 1", [u1.email])).rows[0].otp_code;
  r = await req('POST', '/api/auth/forgot-password/reset', { email: u1.email, otpCode: fotp, newPassword: 'newpass1' });
  ok('forgot reset', r.status === 200 && r.data.ok);
  r = await req('POST', '/api/auth/login', { email: u1.email, password: 'newpass1' });
  ok('login after reset', r.status === 200);
  u1.token = r.data.token;
  // restore password for rest of tests via reset again
  await req('POST', '/api/auth/forgot-password/send-otp', { email: u1.email });
  const fotp2 = (await db.query("SELECT otp_code FROM otps WHERE email=$1 AND type='reset_password' ORDER BY id DESC LIMIT 1", [u1.email])).rows[0].otp_code;
  await req('POST', '/api/auth/forgot-password/reset', { email: u1.email, otpCode: fotp2, newPassword: 'test1234' });
  r = await req('POST', '/api/auth/login', { email: u1.email, password: 'test1234' });
  u1.token = r.data.token;

  // profile
  r = await req('GET', '/api/profile/' + u1.id, null, u1.token);
  ok('get profile', r.status === 200 && r.data.username === u1.username);
  r = await req('PUT', '/api/profile/update', { display_name: 'Scan One', bio: 'hello' }, u1.token);
  ok('update profile', r.status === 200 && r.data.display_name === 'Scan One');
  if (r.data.token) u1.token = r.data.token;

  // settings
  r = await req('PUT', '/api/settings/user', { theme: 'dark', accent_color: '#3b82f6', wallpaper: 'soft' }, u1.token);
  ok('put settings', r.status === 200);
  r = await req('GET', '/api/settings/user', null, u1.token);
  ok('get settings', r.status === 200 && r.data.wallpaper === 'soft');

  // system
  r = await req('GET', '/api/system/info', null, u1.token);
  ok('system info', r.status === 200 && r.data.username === '__system__');

  // contacts flow
  r = await req('POST', '/api/contacts/add', { friendUsername: u2.username }, u1.token);
  ok('add friend', r.status === 200);
  r = await req('POST', '/api/contacts/add', { friendUsername: u2.username }, u1.token);
  ok('add friend duplicate', r.status === 400);
  r = await req('GET', '/api/contacts/requests/' + u2.id, null, u2.token);
  ok('list requests', r.status === 200 && r.data.length >= 1);
  const rid = r.data[0].request_id;
  r = await req('POST', '/api/contacts/requests/respond', { requestId: rid, status: 'accepted' }, u1.token);
  ok('accept by non-receiver forbidden', r.status === 403);
  r = await req('POST', '/api/contacts/requests/respond', { requestId: rid, status: 'accepted' }, u2.token);
  ok('accept by receiver', r.status === 200 && r.data.newContact);
  r = await req('GET', '/api/contacts/' + u1.id, null, u1.token);
  ok('contacts list', r.status === 200 && r.data.some((c) => c.id === u2.id));
  r = await req('GET', '/api/contacts/' + u2.id, null, u1.token);
  ok('contacts idor blocked', r.status === 403);

  // groups
  r = await req('POST', '/api/groups/create', { name: 'Scan Group', description: 'd', memberIds: [u2.id] }, u1.token);
  ok('create group', r.status === 200 && r.data.is_group);
  const gid = r.data.id;
  r = await req('GET', '/api/groups/' + u2.id, null, u2.token);
  ok('u2 sees group', r.status === 200 && r.data.some((g) => g.id === gid));
  r = await req('GET', '/api/groups/' + gid + '/members', null, u1.token);
  ok('group members', r.status === 200 && r.data.length === 2);
  r = await req('PUT', '/api/groups/' + gid, { name: 'Scan Group Renamed', description: 'updated' }, u1.token);
  ok('update group', r.status === 200 && r.data.name === 'Scan Group Renamed');

  // messages history empty
  r = await req('GET', `/api/messages/${u1.id}/${u2.id}?isGroup=false`, null, u1.token);
  ok('dm history empty', r.status === 200 && Array.isArray(r.data));
  r = await req('GET', `/api/messages/${u1.id}/${gid}?isGroup=true`, null, u1.token);
  ok('group history empty', r.status === 200 && Array.isArray(r.data));
  r = await req('GET', `/api/messages/${u2.id}/${gid}?isGroup=true`, null, u1.token);
  ok('group history idor', r.status === 403);

  // upload
  const tmp = path.join(__dirname, '_tmp_upload.txt');
  fs.writeFileSync(tmp, 'hello-upload');
  // use raw multipart via child curl is easier; skip if fails
  const { spawnSync } = require('child_process');
  const up = spawnSync('curl.exe', ['-s', '-X', 'POST', 'http://localhost:3000/api/upload', '-H', `Authorization: Bearer ${u1.token}`, '-F', `file=@${tmp};filename=hello.txt`], { encoding: 'utf8' });
  let upData = {};
  try { upData = JSON.parse(up.stdout || '{}'); } catch (_) {}
  ok('upload', !!upData.url, upData.url || up.stdout);
  fs.unlinkSync(tmp);

  // Socket suite
  const s1 = io('http://localhost:3000', { auth: { token: u1.token } });
  const s2 = io('http://localhost:3000', { auth: { token: u2.token } });
  await Promise.all([
    new Promise((res, rej) => { s1.on('connect', res); s1.on('connect_error', rej); }),
    new Promise((res, rej) => { s2.on('connect', res); s2.on('connect_error', rej); })
  ]);
  ok('socket connect', s1.connected && s2.connected);
  s1.emit('join');
  s2.emit('join');
  s1.emit('join_new_group', gid);
  s2.emit('join_new_group', gid);
  await new Promise((r) => setTimeout(r, 400));

  // typing should not crash server
  s1.emit('typing', { targetId: u2.id, isGroup: false });
  s1.emit('typing', undefined);
  s1.emit('typing', null);
  s1.emit('stop_typing', null);
  s1.emit('send_message', null);
  s1.emit('send_message', {});
  s1.emit('mark_read', null);
  s1.emit('toggle_reaction', null);
  await new Promise((r) => setTimeout(r, 300));
  ok('malformed socket events survived', s1.connected && s2.connected, `s1=${s1.connected} s2=${s2.connected}`);
  // health must still be up
  const healthAfter = await req('GET', '/api/health');
  ok('server alive after bad sockets', healthAfter.status === 200 && healthAfter.data.ok);

  const dmPromise = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('dm timeout')), 5000);
    s2.on('receive_message', (m) => {
      if (!m.group_id && m.content === 'scan-dm-1') { clearTimeout(t); resolve(m); }
    });
  });
  const ackPromise = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('ack timeout')), 5000);
    s1.on('message_sent', (m) => { if (m.content === 'scan-dm-1') { clearTimeout(t); resolve(m); } });
  });
  s1.emit('send_message', { receiverId: u2.id, content: 'scan-dm-1', type: 'text' });
  const [dm, ack] = await Promise.all([dmPromise, ackPromise]);
  ok('socket dm deliver', dm.id && ack.id === dm.id, String(dm.id));

  // delivered status
  const delivered = await new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), 1500);
    s1.on('message_delivered', (p) => { clearTimeout(t); resolve(p); });
  });
  ok('message_delivered event', !!delivered && delivered.messageId === dm.id, JSON.stringify(delivered));

  // mark read
  const readPromise = new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), 2000);
    s1.on('messages_read', (d) => { clearTimeout(t); resolve(d); });
  });
  s2.emit('mark_read', { friendId: u1.id });
  const readEvt = await readPromise;
  ok('messages_read event', !!readEvt && Number(readEvt.by_user_id) === Number(u2.id));

  // reaction
  const reactPromise = new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), 2000);
    s1.on('reaction_updated', (p) => { clearTimeout(t); resolve(p); });
  });
  s2.emit('toggle_reaction', { messageId: dm.id, emoji: '👍' });
  const react = await reactPromise;
  ok('reaction_updated', !!react && react.reactions.some((x) => x.emoji === '👍'));

  // edit / star / pin / delete
  r = await req('PUT', `/api/messages/${dm.id}/edit`, { content: 'scan-dm-edited' }, u1.token);
  ok('edit message', r.status === 200);
  r = await req('POST', `/api/messages/${dm.id}/star`, null, u1.token);
  ok('star message', r.status === 200 && r.data.starred === true);
  r = await req('GET', `/api/messages/starred/${u1.id}`, null, u1.token);
  ok('starred list', r.status === 200 && r.data.some((m) => m.id === dm.id));
  r = await req('GET', `/api/messages/starred/${u1.id}`, null, u2.token);
  ok('starred idor blocked', r.status === 403);
  r = await req('POST', `/api/messages/${dm.id}/pin`, { chatType: 'direct', chatTargetId: u2.id }, u1.token);
  ok('pin message', r.status === 200 && r.data.pinned);
  r = await req('GET', `/api/messages/pinned/direct/${u2.id}`, null, u1.token);
  const r2pin = await req('GET', `/api/messages/pinned/direct/${u1.id}`, null, u2.token);
  ok('pin both sides', r.status === 200 && r2pin.status === 200 && r.data.length === r2pin.data.length);

  // group message
  const gPromise = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('group timeout')), 5000);
    s2.on('receive_message', (m) => {
      if (Number(m.group_id) === Number(gid) && m.content === 'scan-group-1') { clearTimeout(t); resolve(m); }
    });
  });
  s1.emit('send_message', { groupId: gid, content: 'scan-group-1', type: 'text' });
  const gmsg = await gPromise;
  ok('socket group deliver', !!gmsg.id);

  // image message via socket with uploaded url
  if (upData.url) {
    const imgPromise = new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('img timeout')), 5000);
      s2.on('receive_message', (m) => {
        if (m.type === 'image' && m.image_url === upData.url) { clearTimeout(t); resolve(m); }
      });
    });
    s1.emit('send_message', { receiverId: u2.id, content: '', imageUrl: upData.url, type: 'image' });
    const imsg = await imgPromise;
    ok('socket image message', !!imsg.id);
  } else {
    ok('socket image message', false, 'upload missing');
  }

  // delete for everyone
  r = await req('DELETE', `/api/messages/${dm.id}?forEveryone=true`, null, u1.token);
  ok('delete for everyone', r.status === 200);

  // leave group
  r = await req('DELETE', `/api/groups/${gid}/members/${u2.id}`, null, u2.token);
  ok('leave group', r.status === 200);

  // admin denied for normal user
  r = await req('GET', '/api/admin/dashboard/stats', null, u1.token);
  ok('admin denied for user', r.status === 403);

  // add member back then delete group as creator
  await req('POST', `/api/groups/${gid}/members`, { userId: u2.id }, u1.token);
  r = await req('DELETE', `/api/groups/${gid}`, null, u2.token);
  ok('delete group by non-creator forbidden', r.status === 403);
  r = await req('DELETE', `/api/groups/${gid}`, null, u1.token);
  ok('delete group by creator', r.status === 200);

  // avatar delete (no avatar)
  r = await req('DELETE', '/api/profile/avatar', null, u1.token);
  ok('delete avatar', r.status === 200);

  // password change via profile
  r = await req('PUT', '/api/profile/update', { oldPassword: 'test1234', newPassword: 'test5678' }, u1.token);
  ok('password change', r.status === 200);
  if (r.data.token) u1.token = r.data.token;
  r = await req('POST', '/api/auth/login', { email: u1.email, password: 'test5678' });
  ok('login new password', r.status === 200);

  s1.close();
  s2.close();

  const failed = results.filter((x) => !x.pass);
  console.log('\n==== SUMMARY ====');
  console.log(`Total: ${results.length}  Pass: ${results.length - failed.length}  Fail: ${failed.length}`);
  if (failed.length) failed.forEach((f) => console.log(' -', f.name, f.detail));
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
