/* Vercel Serverless 入口：把所有请求交给 Express 应用处理。
 * server.js 已做 serverless 兼容（被引入时不监听端口，只导出 app），
 * 本机开发仍用 `node server.js` 启动，部署到 Vercel 时走这个入口。 */
const app = require('../server');

module.exports = app;
