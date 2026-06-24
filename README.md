# Cloud Autoscaling & Loadbalancer Demo

A lightweight Node.js + Express web app designed to demonstrate **AWS Auto Scaling Group** and **Application Load Balancer** behavior on Amazon Linux 2023 EC2 instances.

The dashboard exposes per-instance metadata (Hostname, EC2 Instance ID, Private IP, AZ, CPU usage, server time) and three buttons that generate sustained CPU load in background worker threads — enough to trigger CloudWatch CPU-based scaling policies without crashing the web server. A **Reset** button terminates all running workers instantly so the instance returns to idle.

---

## Features

- **Dashboard (`/`)** — auto-refreshes every 2 seconds, shows live CPU %, color-coded load bar, active background jobs, server time.
- **Load generator** — three presets backed by `worker_threads` (one worker per CPU core):
  - Small Load (30 s)
  - Medium Load (60 s)
  - Heavy Load (120 s)
- **Reset / Stop All Loads** — terminates every active worker via `worker.terminate()`.
- **ALB health check** — `GET /health` → `{"status":"healthy"}`.
- **JSON status API** — `GET /api/info` returns hostname, instance ID, private IP, AZ, CPU %, uptime, server time, active jobs.
- **EC2 metadata via IMDSv2** — token-based fetch on startup; falls back to local hostname / IP when run outside EC2.
- **Lightweight runtime** — only `express` + `ejs`; everything else is Node.js built-ins. Suitable for `t3.micro`.

---

## Endpoints

| Method | Path                  | Purpose                                                |
|--------|-----------------------|--------------------------------------------------------|
| GET    | `/`                   | EJS dashboard                                          |
| GET    | `/health`             | ALB / target-group health check                        |
| GET    | `/api/info`           | JSON status (used by the dashboard's auto-refresh)     |
| POST   | `/api/load/:size`     | Start CPU load — `size` is `small` \| `medium` \| `heavy` |
| POST   | `/api/reset`          | Terminate all active load workers                      |

---

## Project layout

```
.
├── app.js              # Express server, IMDSv2 client, CPU sampler, routes
├── worker.js           # CPU burn loop (SHA-256) run in worker_threads
├── views/index.ejs     # Dashboard UI
├── package.json        # express + ejs only
├── userdata.sh         # EC2 User Data bootstrap for Amazon Linux 2023
└── .gitignore
```

---

## Local development

```bash
npm install
npm start
# open http://localhost:3000
```

When run outside EC2, IMDS calls time out (~1 s) and the app falls back to the local hostname / first non-loopback IPv4 address. The dashboard still works; the Instance ID column shows `i-local-dev`.

---

## Deploying to a standalone EC2 instance

Use [userdata.sh](userdata.sh) as the **User data** when launching an EC2 instance. No Auto Scaling Group or ALB is required — useful for smoke-testing before wiring up a Launch Template.

### Required EC2 settings

| Setting               | Value                                                  |
|-----------------------|--------------------------------------------------------|
| AMI                   | **Amazon Linux 2023** (script uses `dnf` + AL2023 `nodejs`) |
| Instance type         | `t3.micro` or larger                                   |
| Network               | Public subnet, **Auto-assign public IP = Enable**      |
| Security group inbound| TCP **22** (your IP) + TCP **80** and/or **3000**      |
| IAM instance profile  | Not required (IMDSv2 needs no permissions)             |
| IMDS                  | Default (IMDSv2 required is supported)                 |

### Steps

1. **Edit [userdata.sh](userdata.sh) line 13** — replace `YOUR_GITHUB_USER` with your real GitHub user/org so `git clone` points at your fork:
   ```bash
   GIT_REPO="https://github.com/<your-user>/aws-asg-demo.git"
   ```
2. EC2 Console → **Launch Instance** → pick Amazon Linux 2023.
3. Expand **Advanced details** → paste the full [userdata.sh](userdata.sh) into the **User data** box (including the `#!/bin/bash` shebang).
4. Launch. After ~2–3 minutes the app is reachable at:
   - `http://<public-ip>/` (port 80 → 3000 via iptables)
   - `http://<public-ip>:3000/`

### What `userdata.sh` does

1. `dnf -y install nodejs git` (Node.js 20 from the AL2023 default repo).
2. `git clone` this repo into `/opt/aws-asg-demo`, owned by `ec2-user`.
3. `npm install --omit=dev`.
4. Adds an `iptables` NAT rule `:80 → :3000` so the unprivileged app is reachable on port 80.
5. Writes `/etc/systemd/system/aws-asg-demo.service` and enables auto-restart on boot.
6. Waits for `GET /health` to return 200 before exiting.

Logs:
- `/var/log/cloud-init-output.log` — full user-data output
- `/var/log/aws-asg-demo-bootstrap.log` — same content, written by the script
- `journalctl -u aws-asg-demo -f` — live app logs

---

## Deploying behind an Auto Scaling Group + ALB

The same [userdata.sh](userdata.sh) works unchanged in a **Launch Template**.

### Launch Template

- AMI: Amazon Linux 2023
- Instance type: `t3.micro` (or larger)
- Security group: allow inbound from the **ALB security group** on port 3000
- **User data**: paste [userdata.sh](userdata.sh) (with `GIT_REPO` updated)

### Target Group

| Setting          | Value         |
|------------------|---------------|
| Protocol / Port  | HTTP / 3000   |
| Health check path| `/health`     |
| Healthy threshold| 2             |
| Interval         | 15 s          |

### Auto Scaling Group

- Attach the target group above.
- Suggested scaling policy: **Target tracking on Average CPU = 50 %**.
- Min / Desired / Max: e.g. `1 / 1 / 4`.

### Demo flow

1. Open the ALB DNS name → dashboard shows the instance currently handling the request.
2. Click **Heavy Load (120 s)** a few times across different browser sessions (the ALB will round-robin requests, so different instances will report load).
3. Watch CloudWatch CPUUtilization climb → ASG scales out.
4. Refresh the dashboard repeatedly — the Instance ID / Private IP / AZ change as the ALB routes you to new instances.
5. Click **Reset / Stop All Loads** on each instance to bring CPU back to idle and let the ASG scale back in.

---

## Notes & gotchas

- **User data runs only on first boot.** To re-run after editing the script, terminate and relaunch (or in an ASG, bump the Launch Template version and do an Instance Refresh).
- **Public repo required** — `userdata.sh` uses unauthenticated `git clone`. For a private repo, swap in a deploy key or pre-baked AMI.
- **`worker.terminate()`** stops workers immediately, but the OS-level CPU usage gauge can lag 1–2 seconds before the dashboard reflects the drop.
- **TLS** — the app serves plain HTTP. Terminate TLS at the ALB.

---

## License

MIT

## When Code Changes

apply this below command in vm

```bash
ssh ec2-user@server
cd /opt/aws-autoscaling-demo
git pull
pkill node
nohup node app.js > app.log 2>&1 &
```