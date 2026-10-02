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
  },

  // GitHub 授权登录（GitHub OAuth App，创建即得密钥，无需审核）
  // 申请步骤：GitHub → Settings → Developer settings → OAuth Apps → New OAuth App。
  //   Homepage URL 填前端站点地址；Authorization callback URL 填前端回调页的完整地址，
  //   例如 https://<你的用户名>.github.io/github-login.html（须与这里完全一致）。
  //   创建后随时可修改回调地址，即时生效。
  // 三项全部填写后，登录页的「GitHub 登录」按钮才会启用；留空则接口返回未配置提示。
  // 云端部署时改为配置环境变量 GITHUB_APPID / GITHUB_APPKEY / GITHUB_REDIRECT_URI。
  github: {
    appId: '',       // GitHub OAuth App 的 Client ID
    appKey: '',      // GitHub OAuth App 的 Client Secret（仅保存在服务端，切勿泄露）
    redirectUri: ''  // 授权完成后的回调地址（前端 github-login.html 的完整 URL）
  }
};
