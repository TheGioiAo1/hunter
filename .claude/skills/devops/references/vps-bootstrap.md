# VPS bootstrap

Fresh Ubuntu/Debian box → ready to receive Docker deploys. Run once per host.

Assumes SSH access as root (or a sudo user with key). Target: Ubuntu 22.04 / 24.04 LTS or Debian 12+.

## 1. Base hardening

```bash
# Update + upgrade
apt update && apt upgrade -y

# Create non-root deploy user (example: "deploy")
adduser --disabled-password --gecos "" deploy
usermod -aG sudo deploy

# Copy your SSH key to deploy user
mkdir -p /home/deploy/.ssh
cp ~/.ssh/authorized_keys /home/deploy/.ssh/
chown -R deploy:deploy /home/deploy/.ssh
chmod 700 /home/deploy/.ssh
chmod 600 /home/deploy/.ssh/authorized_keys

# Disable password + root SSH login
sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
systemctl reload sshd

# Firewall — allow SSH, HTTP, HTTPS only
apt install -y ufw
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw enable

# Automatic security updates
apt install -y unattended-upgrades
dpkg-reconfigure -plow unattended-upgrades

# Fail2ban (brute force protection)
apt install -y fail2ban
systemctl enable --now fail2ban
```

## 2. Install Docker Engine + Compose v2

Official Docker repo (not Ubuntu's old `docker.io` package):

```bash
# Prerequisites
apt install -y ca-certificates curl gnupg
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg

# Repo
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
  https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" | \
  tee /etc/apt/sources.list.d/docker.list > /dev/null

# Install
apt update
apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# Add deploy user to docker group (no sudo needed for docker)
usermod -aG docker deploy

# Verify
docker --version
docker compose version
```

Log out + back in (or `newgrp docker`) for the group to take effect.

## 3. Registry auth (pull private images)

Pick your registry:

```bash
# GitHub Container Registry
echo "$GHCR_TOKEN" | docker login ghcr.io -u <github-user> --password-stdin

# Docker Hub
docker login

# AWS ECR
aws ecr get-login-password --region <region> | \
  docker login --username AWS --password-stdin <account-id>.dkr.ecr.<region>.amazonaws.com
# (ECR credentials expire every 12h — use the `credsStore` with the ecr-credential-helper
# for long-running boxes, or refresh via cron)
```

Credentials land in `~/.docker/config.json`. Back this file up if you invested effort in the auth chain.

## 4. Reverse proxy + SSL

Pick ONE: Caddy (easier, auto-HTTPS) or Nginx (more config control).

### Caddy (recommended for most)

```bash
apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
apt update
apt install -y caddy

# Edit /etc/caddy/Caddyfile
cat > /etc/caddy/Caddyfile <<'EOF'
api.example.com {
  reverse_proxy localhost:3000
}

app.example.com {
  reverse_proxy localhost:3001
}
EOF

systemctl reload caddy
```

Auto Let's Encrypt on first request. DNS must point to the VPS IP before reload.

### Nginx

```bash
apt install -y nginx certbot python3-certbot-nginx

# /etc/nginx/sites-available/app.example.com:
server {
  server_name app.example.com;
  location / {
    proxy_pass http://localhost:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
  listen 80;
}

ln -s /etc/nginx/sites-available/app.example.com /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx

# Auto SSL + redirect 80 → 443
certbot --nginx -d app.example.com
```

Certbot adds a cron for renewal automatically.

## 5. Deploy directory + compose

```bash
su - deploy
mkdir -p /srv/app
cd /srv/app
# Commit docker-compose.yml in your repo; on VPS, only fetch it:
curl -fsSL -o docker-compose.yml https://raw.githubusercontent.com/<owner>/<repo>/main/docker-compose.yml
# OR git clone the repo if you want full history available
```

First run: `docker compose pull && docker compose up -d`.

## 6. Log rotation

Docker logs grow unbounded by default. Set rotation globally:

```bash
cat > /etc/docker/daemon.json <<'EOF'
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "5" }
}
EOF
systemctl restart docker
```

## 7. Monitoring (optional but recommended)

Low-friction options:
- **Netdata** — `wget -O /tmp/netdata-kickstart.sh https://get.netdata.cloud/kickstart.sh && sh /tmp/netdata-kickstart.sh`. Dashboard on port 19999 (firewall it or bind to localhost + SSH tunnel).
- **UptimeKuma** in Docker — Compose file with single service, exposes a simple status page.
- **Prometheus + Grafana** — overkill for a single VPS; skip unless you already run K8s.

## 8. Backup (just do it)

At minimum a nightly cron of:
- Database dump → off-box (S3/R2/rsync to another host)
- `/srv/app/.env` + `/etc/caddy/Caddyfile` (or `/etc/nginx/`) → off-box

Example cron for postgres + R2:

```bash
0 3 * * * docker exec pg pg_dump -U postgres mydb | gzip | rclone rcat r2:backups/mydb-$(date +\%F).sql.gz
```

## Common gotchas

- Forgot `usermod -aG docker deploy` → `docker` commands as deploy need `sudo`. Add + re-login.
- Let's Encrypt rate limits: 5 failed validations per hostname per hour. Get DNS right before pointing Caddy/certbot at it.
- UFW blocks Docker's published ports *sometimes* — Docker bypasses UFW by default using iptables. If you expose a port you did NOT mean to, the firewall won't save you. Bind containers to `127.0.0.1:<port>` and reverse-proxy them.
- `docker system prune -af` removes unused images + builders — run nightly to keep disk from filling.
- Timezone matters for cron + logs: `timedatectl set-timezone Asia/Ho_Chi_Minh`.
