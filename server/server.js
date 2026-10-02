'use strict';

/**
 * 邮箱注册 / 登录后端服务
 *   - 注册需要邮箱验证码（通过 SMTP 真实发信）
 *   - 密码使用 scrypt 加盐哈希存储，不保存明文
 *   - 数据层：本地开发用 SQLite 文件（server/data/app.db）；
 *     配置了 TURSO_DATABASE_URL 后自动切到 Turso 云数据库（Netlify 等无持久磁盘的环境用这个）
 *
 * 本机启动： node server.js
 * 云端部署： 由 netlify/functions/api.js 包装成 Netlify Function
 */

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const express = require('express');
const nodemailer = require('nodemailer');
const { createClient } = require('@libsql/client');

/* ============================ 配置 ============================ */

const CONFIG_PATH = path.join(__dirname, 'config.js');
const EXAMPLE_PATH = path.join(__dirname, 'config.example.js');

let fileConfig;
if (fs.existsSync(CONFIG_PATH)) {
  fileConfig = require(CONFIG_PATH);
} else {
  console.warn('[提示] 未找到 server/config.js，改用「环境变量 + config.example.js 默认值」。');
  console.warn('       本机运行：复制 server\\config.example.js 为 server\\config.js 并填入 SMTP 授权码。');
  console.warn('       云端部署：直接在平台的环境变量里填 SMTP_HOST / SMTP_USER / SMTP_PASS 等。');
  fileConfig = require(EXAMPLE_PATH);
}

// 环境变量优先于 config.js：部署到云端时无需把授权码提交进仓库
const ENV = process.env;
const smtpFile = fileConfig.smtp || {};

const config = {
  port: Number(ENV.PORT || fileConfig.port || 3000),
  // 允许调用接口的站点来源，逗号分隔；填 '*' 表示不限制。
  // 前端放在 GitHub Pages 时，这里需包含 https://<你的用户名>.github.io
  corsOrigin: ENV.CORS_ORIGIN || fileConfig.corsOrigin || '',
  smtp: {
    host: ENV.SMTP_HOST || smtpFile.host || '',
    port: Number(ENV.SMTP_PORT || smtpFile.port || 465),
    secure: ENV.SMTP_SECURE ? ENV.SMTP_SECURE !== 'false' : smtpFile.secure !== false,
    user: ENV.SMTP_USER || smtpFile.user || '',
    pass: ENV.SMTP_PASS || smtpFile.pass || '',
    from: ENV.SMTP_FROM || smtpFile.from || 'xxchhxx'
  },
  // GitHub 授权登录（GitHub OAuth App）。Client Secret 只在服务端使用，绝不下发给前端。
  github: {
    appId: ENV.GITHUB_APPID || (fileConfig.github && fileConfig.github.appId) || '',
    appKey: ENV.GITHUB_APPKEY || (fileConfig.github && fileConfig.github.appKey) || '',
    redirectUri: ENV.GITHUB_REDIRECT_URI || (fileConfig.github && fileConfig.github.redirectUri) || ''
  }
};

const PORT = config.port;
const CODE_TTL_MS = 10 * 60 * 1000;      // 验证码有效期：10 分钟
const CODE_RESEND_MS = 60 * 1000;        // 同一邮箱重发冷却：60 秒
const CODE_MAX_ATTEMPTS = 5;             // 单个验证码最多校验 5 次
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 登录态有效期：7 天

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/* ============================ 数据库 ============================ */

const TURSO_URL = ENV.TURSO_DATABASE_URL || '';
const useTurso = Boolean(TURSO_URL);

// 无服务器平台（Netlify Functions 跑在 Lambda 上）只有 /tmp 可写且重启即丢，
// 所以这些环境下必须配置 TURSO_DATABASE_URL；缺失时给一条明确提示，而不是在只读目录里崩溃
const IS_SERVERLESS = Boolean(ENV.NETLIFY || ENV.AWS_LAMBDA_FUNCTION_NAME);

let dbUrl;
let dbConfigError = null;
if (useTurso) {
  dbUrl = TURSO_URL;
} else if (IS_SERVERLESS) {
  dbConfigError =
    '未配置云数据库：请在 Netlify 的 Environment variables 里设置 TURSO_DATABASE_URL 和 ' +
    'TURSO_AUTH_TOKEN，然后重新部署（Deploys → Trigger deploy）。';
  dbUrl = 'file:' + path.join(os.tmpdir(), 'login-app.db').split(path.sep).join('/');
} else {
  const DATA_DIR = ENV.DATA_DIR || path.join(__dirname, 'data');
  fs.mkdirSync(DATA_DIR, { recursive: true });
  dbUrl = 'file:' + path.join(DATA_DIR, 'app.db').split(path.sep).join('/');
}

const client = createClient({ url: dbUrl, authToken: ENV.TURSO_AUTH_TOKEN || undefined });

const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS users (' +
    'id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL, email TEXT NOT NULL UNIQUE, ' +
    'pwd_salt TEXT NOT NULL, pwd_hash TEXT NOT NULL, created_at INTEGER NOT NULL, ' +
    'github_id TEXT)',
  'CREATE TABLE IF NOT EXISTS email_codes (' +
    'email TEXT PRIMARY KEY, code_hash TEXT NOT NULL, expires_at INTEGER NOT NULL, ' +
    'sent_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0)',
  'CREATE TABLE IF NOT EXISTS sessions (' +
    'token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, created_at INTEGER NOT NULL, ' +
    'expires_at INTEGER NOT NULL)'
];

// 建表只在服务初始化时执行一次；所有接口都会先等它完成
const dbReady = (async () => {
  if (dbConfigError) throw new Error(dbConfigError);
  if (!useTurso) {
    try {
      await client.execute('PRAGMA journal_mode = WAL');
    } catch (err) {
      // 本地文件库偶尔不支持 WAL，忽略即可
    }
  }
  await client.batch(SCHEMA);
  // 老库迁移：补 github_id 列、移除早期 QQ/Gitee 方案遗留的列（列不存在/已迁移时报错，忽略即可）
  try {
    await client.execute('ALTER TABLE users ADD COLUMN github_id TEXT');
  } catch (err) {
    if (!/duplicate column/i.test(err.message || '')) console.warn('[迁移提示]', err.message);
  }
  try {
    await client.execute('ALTER TABLE users DROP COLUMN qq_openid');
  } catch (err) {
    if (!/no such column/i.test(err.message || '')) console.warn('[迁移提示]', err.message);
  }
  try {
    await client.execute('ALTER TABLE users DROP COLUMN gitee_id');
  } catch (err) {
    if (!/no such column/i.test(err.message || '')) console.warn('[迁移提示]', err.message);
  }
})();

// 这个 Promise 在「模块加载」阶段就可能 reject（例如缺数据库配置）。
// 那一刻还没有任何请求挂上 .catch，Node 会当成 unhandledRejection 直接干掉函数容器（表现为 502）。
// 先挂一个空 catch 兜住；下面中间件里的 .then().catch() 依旧会返回正常的 500 JSON。
dbReady.catch(() => {});

const run = (sql, args = []) => client.execute({ sql, args });

async function one(sql, args = []) {
  const rs = await run(sql, args);
  return rs.rows[0] || null;
}

const SQL = {
  userByEmail: 'SELECT * FROM users WHERE email = ?',
  userByGithub: 'SELECT * FROM users WHERE github_id = ?',
  insertUser:
    'INSERT INTO users (username, email, pwd_salt, pwd_hash, created_at) VALUES (?, ?, ?, ?, ?)',
  insertGithubUser:
    'INSERT INTO users (username, email, pwd_salt, pwd_hash, created_at, github_id) VALUES (?, ?, ?, ?, ?, ?)',
  codeByEmail: 'SELECT * FROM email_codes WHERE email = ?',
  upsertCode:
    'INSERT INTO email_codes (email, code_hash, expires_at, sent_at, attempts) VALUES (?, ?, ?, ?, 0) ' +
    'ON CONFLICT(email) DO UPDATE SET code_hash = excluded.code_hash, ' +
    'expires_at = excluded.expires_at, sent_at = excluded.sent_at, attempts = 0',
  bumpAttempts: 'UPDATE email_codes SET attempts = attempts + 1 WHERE email = ?',
  deleteCode: 'DELETE FROM email_codes WHERE email = ?',
  deleteSession: 'DELETE FROM sessions WHERE token = ?',
  purgeCodes: 'DELETE FROM email_codes WHERE expires_at < ?',
  insertSession:
    'INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
  sessionUser:
    'SELECT u.username, u.email, u.created_at, s.expires_at FROM sessions s ' +
    'JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > ?'
};

/* ============================ 工具函数 ============================ */

/** 密码加盐哈希（scrypt），返回 { salt, hash } */
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto
    .scryptSync(password.normalize('NFKC'), salt, 64, { N: 16384, r: 8, p: 1 })
    .toString('hex');
  return { salt, hash };
}

/** 恒定时间比较，避免时序侧信道 */
function verifyPassword(password, salt, expectedHex) {
  const actual = crypto.scryptSync(password.normalize('NFKC'), salt, 64, { N: 16384, r: 8, p: 1 });
  const expected = Buffer.from(expectedHex, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

const hashCode = (email, code) =>
  crypto.createHash('sha256').update(email + ':' + code).digest('hex');

const newToken = () => crypto.randomBytes(32).toString('hex');

/* ---------------- 简易 IP 限流（防止接口被刷） ---------------- */

const ipHits = new Map();
function ipRateLimited(ip, max = 12, windowMs = 10 * 60 * 1000) {
  const now = Date.now();
  const hits = (ipHits.get(ip) || []).filter((t) => now - t < windowMs);
  if (hits.length >= max) {
    ipHits.set(ip, hits);
    return true;
  }
  hits.push(now);
  ipHits.set(ip, hits);
  return false;
}

/* ---------------- 邮件发送 ---------------- */

const smtpReady = () => {
  const s = config.smtp || {};
  return Boolean(s.host && s.user && s.pass);
};

// 组装 From 头。只填显示名（如 "xxchhxx"）时补上真实发件邮箱，
// 否则裸名字会被邮件服务商当成非法地址而拒收；若写成完整邮箱（含 @）则原样使用。
function fromHeader() {
  const name = String(config.smtp.from || '').trim();
  const user = String(config.smtp.user || '').trim();
  if (!name) return user;
  if (name.indexOf('@') !== -1) return name;
  return '"' + name.replace(/"/g, '') + '" <' + user + '>';
}

let transporter = null;
function mailer() {
  if (!transporter) {
    const s = config.smtp;
    transporter = nodemailer.createTransport({
      host: s.host,
      port: s.port || 465,
      secure: s.secure !== false,
      auth: { user: s.user, pass: s.pass }
    });
  }
  return transporter;
}

function mailHtml(code) {
  const font = "'Segoe UI','Microsoft YaHei',sans-serif";
  return (
    '<div style="font-family:' + font + ';background:#f2f5fa;padding:32px">' +
    '<div style="max-width:520px;margin:0 auto;background:#fff;border-radius:14px;overflow:hidden;' +
    'box-shadow:0 8px 28px rgba(20,50,110,.12)">' +
    '<div style="background:linear-gradient(135deg,#2a6dff,#5fcaff);padding:24px 28px;color:#fff">' +
    '<div style="font-size:18px;font-weight:600">邮箱验证码</div>' +
    '</div>' +
    '<div style="padding:28px">' +
    '<p style="margin:0 0 18px;color:#33415c;font-size:14px">' +
    '你正在注册账号，请在页面中填入以下验证码完成验证：</p>' +
    '<div style="font-size:32px;font-weight:700;letter-spacing:8px;color:#0078D4;' +
    'background:#eef5ff;border-radius:10px;padding:16px;text-align:center">' + code + '</div>' +
    '<p style="margin:18px 0 0;color:#7b879e;font-size:12.5px">' +
    '验证码 10 分钟内有效。若非本人操作，请忽略本邮件。</p>' +
    '</div></div></div>'
  );
}

/* ============================ HTTP 服务 ============================ */

const app = express();
app.disable('x-powered-by');
// 部署在 Netlify / 反向代理后，用 X-Forwarded-For 的第一跳作为客户端 IP
app.set('trust proxy', 1);
app.use(express.json({ limit: '16kb' }));

/* ---------------- 跨域：允许 GitHub Pages 等外部站点调用接口 ---------------- */

const DEFAULT_ORIGINS = [
  'https://xxchhxx.github.io',   // 前端所在的 GitHub Pages
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'null'                         // 直接用浏览器打开本地 index.html 时 Origin 为 null
];
const allowOrigins = (config.corsOrigin ? config.corsOrigin.split(',') : DEFAULT_ORIGINS)
  .map((s) => String(s).trim())
  .filter(Boolean);
const allowAllOrigins = allowOrigins.includes('*');

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && (allowAllOrigins || allowOrigins.includes(origin))) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Vary', 'Origin');
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    // 开始界面会用 Authorization: Bearer <token> 调 GET /api/me，预检必须放行该头
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.set('Access-Control-Max-Age', '600');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204); // 预检请求
  next();
});

/* ---------------- 数据库就绪检查 ---------------- */

app.use((_req, res, next) => {
  dbReady.then(() => next()).catch((err) => {
    console.error('[数据库不可用]', err.message);
    res.status(500).json({
      ok: false,
      message:
        dbConfigError || '数据库连接失败，请检查 TURSO_DATABASE_URL / TURSO_AUTH_TOKEN 配置'
    });
  });
});

/** 统一的失败返回 */
const fail = (res, status, message) => res.status(status).json({ ok: false, message });

function checkCredentials({ username, email, code, password }, needCode) {
  if (!username || username.trim().length < 2 || username.trim().length > 20) {
    return '用户名长度需为 2–20 个字符';
  }
  if (!EMAIL_RE.test(email)) return '请输入有效的邮箱地址';
  if (password.length < 8) return '密码至少需要 8 位';
  if (needCode && !/^\d{6}$/.test(code)) return '请输入 6 位数字验证码';
  return null;
}

/** 发送注册验证码 */
app.post('/api/send-code', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();

  if (!EMAIL_RE.test(email)) return fail(res, 400, '请输入有效的邮箱地址');
  if (await one(SQL.userByEmail, [email])) return fail(res, 409, '该邮箱已注册，请直接登录');
  if (ipRateLimited(req.ip)) return fail(res, 429, '操作过于频繁，请稍后再试');

  const now = Date.now();
  const existing = await one(SQL.codeByEmail, [email]);
  const lastSent = existing ? Number(existing.sent_at) : 0;
  if (existing && now - lastSent < CODE_RESEND_MS) {
    const wait = Math.ceil((CODE_RESEND_MS - (now - lastSent)) / 1000);
    return fail(res, 429, '请求过于频繁，请 ' + wait + ' 秒后再试');
  }

  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const dev = !smtpReady();

  if (!dev) {
    try {
      await mailer().sendMail({
        from: fromHeader(),
        to: email,
        subject: '【注册验证码】请在 10 分钟内完成验证',
        html: mailHtml(code)
      });
    } catch (err) {
      console.error('[邮件发送失败]', err.message);
      return res.status(502).json({
        ok: false,
        message: '验证码发送失败，请检查 SMTP 配置后重试'
      });
    }
  } else {
    console.warn('[开发模式] SMTP 未配置，' + email + ' 的验证码为：' + code + '（10 分钟内有效）');
  }

  await run(SQL.purgeCodes, [now]); // 顺手清理过期验证码
  await run(SQL.upsertCode, [email, hashCode(email, code), now + CODE_TTL_MS, now]);

  res.json({
    ok: true,
    cooldown: CODE_RESEND_MS / 1000,
    dev,
    devCode: dev ? code : undefined,
    message: dev
      ? '开发模式（SMTP 未配置）：本次验证码为 ' + code
      : '验证码已发送至 ' + email + '，10 分钟内有效'
  });
});

/** 注册 */
app.post('/api/register', async (req, res) => {
  const username = String(req.body?.username || '').trim();
  const email = String(req.body?.email || '').trim().toLowerCase();
  const code = String(req.body?.code || '').trim();
  const password = String(req.body?.password || '');

  const err = checkCredentials({ username, email, code, password }, true);
  if (err) return fail(res, 400, err);

  if (await one(SQL.userByEmail, [email])) return fail(res, 409, '该邮箱已注册，请直接登录');

  const record = await one(SQL.codeByEmail, [email]);
  if (!record) return fail(res, 400, '请先获取邮箱验证码');

  const now = Date.now();
  if (now > Number(record.expires_at)) {
    await run(SQL.deleteCode, [email]);
    return fail(res, 400, '验证码已过期，请重新获取');
  }
  if (Number(record.attempts) >= CODE_MAX_ATTEMPTS) {
    await run(SQL.deleteCode, [email]);
    return fail(res, 429, '验证码错误次数过多，请重新获取');
  }
  if (hashCode(email, code) !== record.code_hash) {
    await run(SQL.bumpAttempts, [email]);
    return fail(res, 400, '验证码不正确');
  }

  const { salt, hash } = hashPassword(password);
  const info = await run(SQL.insertUser, [username, email, salt, hash, now]);
  await run(SQL.deleteCode, [email]);

  const token = newToken();
  await run(SQL.insertSession, [token, Number(info.lastInsertRowid), now, now + SESSION_TTL_MS]);

  res.json({
    ok: true,
    token,
    user: { username, email },
    createdAt: now,
    expiresAt: now + SESSION_TTL_MS,
    message: '注册成功'
  });
});

/** 登录 */
app.post('/api/login', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');

  if (!EMAIL_RE.test(email) || !password) return fail(res, 400, '请输入邮箱和密码');

  const user = await one(SQL.userByEmail, [email]);
  // 邮箱不存在与密码错误返回相同提示，避免泄露账号是否注册
  if (!user || !verifyPassword(password, user.pwd_salt, user.pwd_hash)) {
    return fail(res, 401, '邮箱或密码不正确');
  }

  const now = Date.now();
  const token = newToken();
  await run(SQL.insertSession, [token, Number(user.id), now, now + SESSION_TTL_MS]);

  res.json({
    ok: true,
    token,
    user: { username: user.username, email: user.email },
    createdAt: Number(user.created_at),
    expiresAt: now + SESSION_TTL_MS,
    message: '登录成功'
  });
});

/** 取当前登录用户：开始界面刷新后靠它恢复身份 */
app.get('/api/me', async (req, res) => {
  const m = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || ''));
  if (!m) return fail(res, 401, '缺少登录凭证');

  const row = await one(SQL.sessionUser, [m[1], Date.now()]);
  if (!row) return fail(res, 401, '登录已过期，请重新登录');

  res.json({
    ok: true,
    user: { username: row.username, email: row.email },
    createdAt: Number(row.created_at),
    expiresAt: Number(row.expires_at)
  });
});

/** 退出登录：删掉服务端会话，避免 token 被继续使用 */
app.post('/api/logout', async (req, res) => {
  const m = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || ''));
  if (m) await run(SQL.deleteSession, [m[1]]);
  res.json({ ok: true, message: '已退出登录' });
});

/* ============================ GitHub 授权登录（GitHub OAuth App） ============================
 * 流程（授权码模式，应用在 GitHub → Settings → Developer settings → OAuth Apps 创建，免审核）：
 *   1. 前端调 GET  /api/github/start            → 返回 GitHub 授权页地址 + 签名 state
 *   2. 前端弹窗打开授权页，用户登录 GitHub 并确认授权
 *   3. GitHub 重定向到 redirectUri（前端 github-login.html），页面把 code/state 发回 opener
 *   4. 前端调 POST /api/github/exchange {code,state} → 服务端校验 state 后换取 access_token、
 *      获取用户资料，自动建号/登录并下发会话 token
 * 安全要点：
 *   - state 由服务端用 Client Secret 做 HMAC 签名（含随机 nonce 与 10 分钟过期），防伪造与 CSRF
 *   - Client Secret 只存在服务端；access_token 不下发前端，会话仍用本站的随机 token
 *   - code 一次性使用（内存去重 + GitHub 侧 code 自然过期兜底）；接口走 IP 限流
 */

const githubReady = () => Boolean(config.github.appId && config.github.appKey && config.github.redirectUri);

const GITHUB_STATE_TTL_MS = 10 * 60 * 1000; // state 有效期：10 分钟

/** state = nonce.exp.hmac(nonce+exp, Client Secret)：无状态签名，serverless 多实例也能校验 */
function makeGithubState() {
  const nonce = crypto.randomBytes(16).toString('hex');
  const exp = Date.now() + GITHUB_STATE_TTL_MS;
  const sig = crypto.createHmac('sha256', config.github.appKey)
    .update(nonce + '.' + exp).digest('hex');
  return nonce + '.' + exp + '.' + sig;
}

function verifyGithubState(state) {
  const parts = String(state || '').split('.');
  if (parts.length !== 3) return false;
  const [nonce, exp, sig] = parts;
  if (!/^\d+$/.test(exp) || Date.now() > Number(exp)) return false;
  const expect = crypto.createHmac('sha256', config.github.appKey)
    .update(nonce + '.' + exp).digest('hex');
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** 已使用过的授权码短期去重（code 本身一次性，GitHub 侧过期是最终兜底） */
const usedGithubCodes = new Set();
setInterval(() => usedGithubCodes.clear(), 30 * 60 * 1000).unref?.();

/** 第 1 步：生成授权页地址 */
app.get('/api/github/start', async (req, res) => {
  if (!githubReady()) {
    return fail(res, 501, 'GitHub 登录尚未配置：请在服务端设置 GITHUB_APPID / GITHUB_APPKEY / GITHUB_REDIRECT_URI');
  }
  if (ipRateLimited(req.ip)) return fail(res, 429, '操作过于频繁，请稍后再试');

  const state = makeGithubState();
  const url =
    'https://github.com/login/oauth/authorize' +
    '?response_type=code' +
    '&client_id=' + encodeURIComponent(config.github.appId) +
    '&redirect_uri=' + encodeURIComponent(config.github.redirectUri) +
    '&state=' + encodeURIComponent(state) +
    '&scope=' + encodeURIComponent('read:user');

  res.json({ ok: true, url, state, message: '请在新窗口完成 GitHub 授权' });
});

/** 第 2 步：用回调 code 换取用户身份，自动建号/登录 */
app.post('/api/github/exchange', async (req, res) => {
  if (!githubReady()) {
    return fail(res, 501, 'GitHub 登录尚未配置：请设置 GITHUB_APPID / GITHUB_APPKEY / GITHUB_REDIRECT_URI');
  }
  if (ipRateLimited(req.ip)) return fail(res, 429, '操作过于频繁，请稍后再试');

  const code = String(req.body?.code || '').trim();
  const state = String(req.body?.state || '').trim();
  if (!/^[A-Za-z0-9]{6,64}$/.test(code)) return fail(res, 400, '授权码格式不正确');
  if (!verifyGithubState(state)) return fail(res, 400, '授权状态校验失败，请重新发起授权登录');
  if (usedGithubCodes.has(code)) return fail(res, 400, '授权码已被使用，请重新授权');
  usedGithubCodes.add(code);

  // 2.1 code → access_token（GitHub 要求 POST，Accept: application/json 返回 JSON）
  const tokenData = await (async () => {
    try {
      const r = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          client_id: config.github.appId,
          client_secret: config.github.appKey,
          code,
          redirect_uri: config.github.redirectUri
        })
      });
      if (!r.ok) throw new Error('GitHub 接口 HTTP ' + r.status);
      return await r.json();
    } catch {
      return null;
    }
  })();
  const accessToken = tokenData && tokenData.access_token;
  if (!accessToken) return fail(res, 401, 'GitHub 授权码无效或已过期，请重新授权');

  // 2.2 access_token → 用户资料（id 唯一且不变；GitHub API 要求带 User-Agent）
  const profile = await (async () => {
    try {
      const r = await fetch('https://api.github.com/user', {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: 'Bearer ' + accessToken,
          'User-Agent': 'ch-music-login',
          'X-GitHub-Api-Version': '2022-11-28'
        }
      });
      if (!r.ok) throw new Error('GitHub 接口 HTTP ' + r.status);
      return await r.json();
    } catch {
      return null;
    }
  })();
  const githubId = profile && (profile.id !== undefined && profile.id !== null)
    ? String(profile.id)
    : '';
  if (!/^\d{1,20}$/.test(githubId)) return fail(res, 401, '无法获取 GitHub 身份标识，请重新授权');
  const loginName = profile.login ? String(profile.login).trim().slice(0, 20) : '';
  const displayName = profile.name ? String(profile.name).trim().slice(0, 20) : '';
  const avatar = profile.avatar_url ? String(profile.avatar_url) : '';

  // 2.3 查找 / 创建本地账号
  let user = await one(SQL.userByGithub, [githubId]);
  if (!user) {
    // 用户名冲突时追加序号；邮箱列 UNIQUE，GitHub 号用合成的占位邮箱（不可用于密码登录）
    let username = displayName || loginName || 'GitHub用户';
    if (username.length < 2) username = 'GitHub用户' + username;
    let candidate = username;
    for (let i = 2; i < 100; i++) {
      const exist = await one('SELECT id FROM users WHERE username = ?', [candidate]);
      if (!exist) break;
      candidate = username + i;
    }
    const email = 'github_' + githubId + '@github.local';
    const { salt, hash } = hashPassword(crypto.randomBytes(24).toString('hex'));
    const info2 = await run(SQL.insertGithubUser, [
      candidate, email, salt, hash, Date.now(), githubId
    ]);
    user = { id: Number(info2.lastInsertRowid), username: candidate, email, created_at: Date.now() };
  }

  // 2.4 下发本站会话（与密码登录同构，前端无感）
  const now = Date.now();
  const token = newToken();
  await run(SQL.insertSession, [token, Number(user.id), now, now + SESSION_TTL_MS]);

  res.json({
    ok: true,
    token,
    user: { username: user.username, email: user.email, avatar },
    createdAt: Number(user.created_at),
    expiresAt: now + SESSION_TTL_MS,
    message: 'GitHub 登录成功'
  });
});

/* 本机运行时顺手把首页也发出去。云端（Netlify）只部署 server 目录，取不到上一级的 index.html，
   此时返回一句提示即可，前端页面走 GitHub Pages。 */
app.get('/', (_req, res) => {
  const indexFile = path.join(__dirname, '..', 'index.html');
  if (!fs.existsSync(indexFile)) {
    return res.type('text/plain').send('后端已就绪。前端页面请访问你的 GitHub Pages 地址。');
  }
  // 开发期间禁用页面缓存：每次都要回源校验，避免浏览器执行旧脚本。
  // 这里刻意不用 no-store —— 部分预览环境遇到 no-store 会取消/重发文档请求，
  // 在控制台里表现为 net::ERR_ABORTED（页面其实已经加载成功）。
  res.set('Cache-Control', 'no-cache, max-age=0, must-revalidate');
  res.sendFile(indexFile);
});

/* GitHub 登录回调页：本地开发时 redirect_uri 指向后端域名（如 http://localhost:3000/github-login.html），
   需要由后端直接发出；部署形态下该文件在前端站点（GitHub Pages）根目录，同名同内容。 */
app.get('/github-login.html', (_req, res) => {
  const file = path.join(__dirname, '..', 'github-login.html');
  if (!fs.existsSync(file)) {
    return res
      .status(404)
      .type('text/plain')
      .send('未找到 github-login.html。部署形态下请把它放到前端站点根目录。');
  }
  res.set('Cache-Control', 'no-cache, max-age=0, must-revalidate');
  res.sendFile(file);
});

/* JSON 解析失败等异常，也返回 JSON，避免前端拿到 HTML 报错页 */
app.use((err, _req, res, _next) => {
  console.error('[服务异常]', err.message);
  res.status(err.status || 500).json({ ok: false, message: '服务器内部错误' });
});

/* 本机直接 node server.js 时才监听端口；被 Netlify Function 引入时只导出 app */
if (require.main === module) {
  app.listen(PORT, () => {
    console.log('--------------------------------------------------');
    console.log('  服务已启动： http://localhost:' + PORT);
    console.log('  数据存储：   ' + (useTurso ? 'Turso 云数据库' : '本地文件 ' + dbUrl));
    console.log('  发信模式：   ' + (smtpReady() ? 'SMTP 真实发信' : '开发模式（验证码显示在页面上）'));
    console.log('--------------------------------------------------');
  });
}

module.exports = app;
