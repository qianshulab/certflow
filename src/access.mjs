import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

// Remote access uses one explicitly configured origin. Proxy forwarding headers
// are deliberately not used to decide whom to trust.
export function createAccess({ host = '127.0.0.1', publicUrl, adminPassword } = {}) {
  if (!['127.0.0.1', '0.0.0.0'].includes(host)) throw new Error('监听地址只支持 127.0.0.1 或 0.0.0.0。');
  const remote = host === '0.0.0.0';
  if (remote && !publicUrl) throw new Error('Docker / 网络访问必须设置 CERTFLOW_PUBLIC_URL 为浏览器使用的完整地址。');
  let publicOrigin;
  if (publicUrl) {
    const address = new URL(publicUrl);
    if (!['http:', 'https:'].includes(address.protocol) || address.username || address.password || address.pathname !== '/' || address.search || address.hash) throw new Error('CERTFLOW_PUBLIC_URL 必须是 http(s) 地址，不能含路径、账号或查询参数。');
    publicOrigin = address.origin;
  }
  const requiresLogin = remote || Boolean(adminPassword);
  if (requiresLogin && (typeof adminPassword !== 'string' || adminPassword.length < 12 || adminPassword.length > 1024 || /[\x00-\x1f]/.test(adminPassword))) throw new Error('管理密码必须为 12–1024 个字符，请设置 CERTFLOW_ADMIN_PASSWORD。');
  const salt = randomBytes(32);
  const passwordHash = requiresLogin ? scryptSync(adminPassword, salt, 32) : null;
  const sessions = new Map(), failures = new Map();
  const lifetime = 12 * 60 * 60 * 1000;
  const digest = (value) => createHash('sha256').update(value).digest('hex');
  function cookie(request) {
    const matches = (request.headers.cookie ?? '').split(';').map((v) => v.trim()).filter((v) => v.startsWith('certflow_session='));
    return matches.length === 1 ? matches[0].slice('certflow_session='.length) : '';
  }
  function cookieHeader(value, maxAge) { return `certflow_session=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${publicOrigin?.startsWith('https:') ? '; Secure' : ''}`; }
  return {
    remote, requiresLogin,
    origin(localUrl) { return publicOrigin ?? localUrl; },
    authorized(request) {
      if (!requiresLogin) return true;
      const token = cookie(request);
      if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return false;
      const key = digest(token), expiry = sessions.get(key);
      if (!expiry || expiry <= Date.now()) { sessions.delete(key); return false; }
      return true;
    },
    login(request, password) {
      const ip = request.socket.remoteAddress ?? 'unknown';
      const now = Date.now();
      for (const [key, value] of failures) if (value.until <= now) failures.delete(key);
      const attempts = failures.get(ip) ?? { count: 0, until: now + 60_000 };
      if (attempts.count >= 8) return { status: 429, error: '尝试次数过多，请一分钟后重试。' };
      if (failures.size >= 256 && !failures.has(ip)) failures.delete(failures.keys().next().value);
      const validShape = typeof password === 'string' && password.length >= 12 && password.length <= 1024;
      const candidate = scryptSync(validShape ? password : 'invalid-password', salt, 32);
      if (!passwordHash || !validShape || !timingSafeEqual(candidate, passwordHash)) {
        attempts.count++; failures.set(ip, attempts); return { status: 401, error: '密码不正确。' };
      }
      failures.delete(ip);
      for (const [key, expiry] of sessions) if (expiry <= now) sessions.delete(key);
      while (sessions.size >= 8) sessions.delete(sessions.keys().next().value);
      const token = randomBytes(32).toString('base64url');
      sessions.set(digest(token), now + lifetime);
      return { status: 200, cookie: cookieHeader(token, lifetime / 1000) };
    },
    logout(request) { sessions.delete(digest(cookie(request))); return cookieHeader('', 0); },
    clear() { sessions.clear(); failures.clear(); },
  };
}
