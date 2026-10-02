#!/usr/bin/env bash
#
# 邮箱验证码服务 - 国内轻量服务器一键部署脚本
# 适用：Ubuntu 20.04 / 22.04 / 24.04（Debian 亦可），用 root 执行
#
# 用法（在服务器上）：
#   curl -fsSL https://raw.githubusercontent.com/xxchhxx/login-page/main/server/deploy.sh | bash
#
set -e

APP_DIR=/opt/login-page
APP_PORT=${APP_PORT:-80}
NODE_VER=v20.18.1
REPO_PATHS=(
  "https://github.com/xxchhxx/login-page.git"
  "https://ghfast.top/https://github.com/xxchhxx/login-page.git"
  "https://gh-proxy.com/https://github.com/xxchhxx/login-page.git"
)

echo "== 1/6 安装基础软件 =="
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y git curl xz-utils ca-certificates

echo "== 2/6 安装 Node.js =="
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | sed 's/^v//' | cut -d. -f1)" -lt 18 ]; then
  ARCH=linux-x64
  TARBALL=node-$NODE_VER-$ARCH.tar.xz
  curl -fsSL -o /tmp/$TARBALL "https://npmmirror.com/mirrors/node/$NODE_VER/$TARBALL"
  mkdir -p /usr/local/lib/nodejs
  tar -xJf /tmp/$TARBALL -C /usr/local/lib/nodejs
  ln -sf /usr/local/lib/nodejs/node-$NODE_VER-$ARCH/bin/node /usr/local/bin/node
  ln -sf /usr/local/lib/nodejs/node-$NODE_VER-$ARCH/bin/npm  /usr/local/bin/npm
  ln -sf /usr/local/lib/nodejs/node-$NODE_VER-$ARCH/bin/npx  /usr/local/bin/npx
fi
node -v
npm config set registry https://registry.npmmirror.com

echo "== 3/6 拉取代码 =="
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" pull --ff-only || true
else
  ok=0
  for r in "${REPO_PATHS[@]}"; do
    echo "尝试 $r"
    if git clone --depth 1 "$r" "$APP_DIR"; then ok=1; break; fi
    rm -rf "$APP_DIR"
  done
  if [ "$ok" != "1" ]; then
    echo "!! 代码拉取失败。可改用本地上传：把电脑上的 server 目录传到 $APP_DIR/server 再重跑本脚本。"
    exit 1
  fi
fi

echo "== 4/6 安装依赖 =="
cd "$APP_DIR/server"
npm install --omit=dev

echo "== 5/6 准备配置文件 =="
if [ ! -f config.js ]; then
  cp config.example.js config.js
  echo "已生成 $APP_DIR/server/config.js（SMTP 还是空的，待会要填）"
fi

echo "== 6/6 注册开机自启服务 =="
NODE_BIN=$(command -v node)
cat > /etc/systemd/system/login-server.service <<EOF
[Unit]
Description=Login email code server
After=network.target

[Service]
WorkingDirectory=$APP_DIR/server
Environment=PORT=$APP_PORT
ExecStart=$NODE_BIN $APP_DIR/server/server.js
Restart=always
RestartSec=3
User=root

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable login-server
systemctl restart login-server
sleep 2
systemctl --no-pager --lines=12 status login-server || true

IP=$(hostname -I | awk '{print $1}')
echo ""
echo "=================================================="
echo " 部署完成，访问地址： http://$IP:$APP_PORT/"
echo "=================================================="
echo ""
echo "还没完，最后两步："
echo " 1) 填 SMTP（国内服务器请用 QQ/163 邮箱，Gmail 连不上）"
echo "      nano $APP_DIR/server/config.js"
echo " 2) 改完重启"
echo "      systemctl restart login-server"
echo ""
echo "看日志： journalctl -u login-server -f"
echo "改端口： 编辑 /etc/systemd/system/login-server.service 里的 PORT 后 systemctl daemon-reload && systemctl restart login-server"
