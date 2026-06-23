#!/bin/bash
###############################################################################
# AWS Auto Scaling Group demo - EC2 User Data (Amazon Linux 2023)
#
# Bootstraps a fresh AL2023 instance to run the aws-asg-demo Node.js app
# directly from a public GitHub repository, behind systemd.
#
# Customize the variables below for your fork / branch / port.
###############################################################################
set -euxo pipefail

# ---- configuration ----------------------------------------------------------
GIT_REPO="https://github.com/YOUR_GITHUB_USER/aws-asg-demo.git"
GIT_BRANCH="main"
APP_DIR="/opt/aws-asg-demo"
APP_USER="ec2-user"
APP_PORT="3000"
LOG_FILE="/var/log/aws-asg-demo-bootstrap.log"

exec > >(tee -a "$LOG_FILE") 2>&1
echo "[user-data] started $(date -Is)"

# ---- system packages --------------------------------------------------------
dnf -y update
dnf -y install git tar gzip findutils shadow-utils

# Node.js 20 from Amazon Linux 2023 default repo
dnf -y install nodejs

node --version
npm --version

# ---- fetch application source ----------------------------------------------
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" fetch --all
  git -C "$APP_DIR" reset --hard "origin/${GIT_BRANCH}"
else
  rm -rf "$APP_DIR"
  git clone --branch "$GIT_BRANCH" --depth 1 "$GIT_REPO" "$APP_DIR"
fi

chown -R "$APP_USER":"$APP_USER" "$APP_DIR"

# ---- install npm dependencies ----------------------------------------------
sudo -u "$APP_USER" -H bash -c "cd '$APP_DIR' && npm install --omit=dev --no-audit --no-fund"

# ---- redirect :80 -> :3000 so the app can run unprivileged -----------------
# ALB target group should still point at $APP_PORT; this is for direct browser
# testing via the instance public IP.
if command -v iptables >/dev/null 2>&1; then
  iptables -t nat -C PREROUTING -p tcp --dport 80 -j REDIRECT --to-port "$APP_PORT" 2>/dev/null \
    || iptables -t nat -A PREROUTING -p tcp --dport 80 -j REDIRECT --to-port "$APP_PORT"
fi

# ---- systemd unit -----------------------------------------------------------
cat >/etc/systemd/system/aws-asg-demo.service <<EOF
[Unit]
Description=AWS ASG Demo (Node.js Express)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${APP_USER}
WorkingDirectory=${APP_DIR}
Environment=NODE_ENV=production
Environment=PORT=${APP_PORT}
ExecStart=/usr/bin/node ${APP_DIR}/app.js
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
# Allow CPU-intensive worker threads; do not throttle.
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable aws-asg-demo.service
systemctl restart aws-asg-demo.service

# ---- wait for health check to pass -----------------------------------------
for i in {1..30}; do
  if curl -fsS "http://127.0.0.1:${APP_PORT}/health" >/dev/null; then
    echo "[user-data] app healthy after ${i} attempts"
    break
  fi
  sleep 2
done

systemctl --no-pager status aws-asg-demo.service || true
echo "[user-data] finished $(date -Is)"
