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

  // Gitee 扫码登录（Gitee OAuth 2.0，个人开发者可直接创建应用，无需审核）
  // 申请步骤：https://gitee.com/oauth/applications → 创建应用。
  //   应用名称 / 主页随意填；回调地址填前端回调页的完整地址，
  //   例如 https://<你的用户名>.github.io/gitee-login.html（须与这里完全一致）。
  //   权限勾选 user_info 即可。创建后可随时在应用详情里更换回调地址，无需审核。
  // 三项全部填写后，登录页的「Gitee 扫码登录」按钮才会启用；留空则接口返回未配置提示。
  // 云端部署时改为配置环境变量 GITEE_APPID / GITEE_APPKEY / GITEE_REDIRECT_URI。
  gitee: {
    appId: '',       // Gitee 应用的 Client ID
    appKey: '',      // Gitee 应用的 Client Secret（仅保存在服务端，切勿泄露）
    redirectUri: ''  // 授权完成后的回调地址（前端 gitee-login.html 的完整 URL）
  }
};
