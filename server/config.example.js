// ============================================================
// 配置模板：复制此文件为同目录下的 config.js，再填入你自己的邮箱信息。
// config.js 已被根目录 .gitignore 忽略，不会提交到仓库（里面是授权码，切勿泄露）。
//
//   Windows PowerShell:
//     Copy-Item server\config.example.js server\config.js
// ============================================================

module.exports = {
  // 本机服务端口，浏览器访问 http://localhost:3000
  port: 3000,

  // 发送注册验证码用的 SMTP 邮箱
  // 常见服务商：
  //   QQ 邮箱   host: smtp.qq.com     port: 465  授权码在「设置 → 账户 → POP3/SMTP服务」中生成
  //   163 邮箱  host: smtp.163.com    port: 465  授权码在「设置 → POP3/SMTP/IMAP」中生成
  //   Gmail     host: smtp.gmail.com  port: 465  需使用「应用专用密码」
  // 留空则服务进入「开发模式」：验证码直接显示在页面上，方便本地调试。
  smtp: {
    host: '',
    port: 465,
    secure: true,   // 465 端口用 true；587 端口用 false
    user: '',       // 发信邮箱地址
    pass: '',       // 授权码 / 应用专用密码（不是邮箱登录密码）
    from: ''        // 发件人显示名，留空则使用 user
  }
};
