'use strict';

/**
 * Netlify Functions 入口：把 server/server.js 里的 Express 应用包装成 Netlify 的 handler。
 *
 * netlify.toml 会把 /api/* 转发到这里，但转发后的路径会带上 /.netlify/functions/api 前缀，
 * 例如 /api/send-code 会变成 /.netlify/functions/api/send-code。
 * 这里先把前缀剥掉，还原成 Express 路由认识的 /api/send-code。
 */

const serverless = require('serverless-http');
const app = require('../../server.js');

const PREFIX = '/.netlify/functions/api';

const strip = (value) =>
  typeof value === 'string' && value.startsWith(PREFIX)
    ? value.slice(PREFIX.length) || '/'
    : value;

const handler = serverless(app);

exports.handler = (event, context) => {
  event.path = strip(event.path);
  event.rawPath = strip(event.rawPath);
  if (event.requestContext && event.requestContext.http) {
    event.requestContext.http.path = strip(event.requestContext.http.path);
  }
  return handler(event, context);
};
