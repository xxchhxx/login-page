'use strict';

// Vercel Serverless 入口：把 Express 应用直接交给 Vercel 的 Node 运行时。
// vercel.json 里的 rewrites 会把所有路径都转发到这里，路由仍由 Express 处理。
module.exports = require('../server.js');
