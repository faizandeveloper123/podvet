#!/usr/bin/env bash
# One-time provisioning for the PodVet VPS. Idempotent: safe to re-run.
set -euo pipefail

# Derived from: Contabo VPS 81.17.101.93  (subdomain: podvet.biztrack.uk)
APP_DIR="/opt/podvet"
DOMAIN="${PODVET_DOMAIN:-podvet.biztrack.uk}"
APP_PORT=8080
DB_NAME=podvet
DB_PREFIX="podvet_clinic_"
DB_HOST=127.0.0.1
DB_PORT=3306

# ── 1. System packages ────────────────────────────────────────────────────────
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
if ! command -v mysql >/dev/null 2>&1; then
  apt-get update -y
  DEBIAN_FRONTEND=noninteractive apt-get install -y mysql-server
  systemctl enable --now mysql
fi
if ! command -v nginx >/dev/null 2>&1; then
  apt-get install -y nginx
fi
if ! command -v certbot >/dev/null 2>&1; then
  apt-get install -y certbot python3-certbot-nginx
fi

# ── 2. Isolated MySQL database + user ────────────────────────────────────────
# Grants are limited to podvet / podvet_clinic_* ONLY, so shared databases
# (podvet, clinic_*, …) on the same MySQL server are never affected.
if [ ! -f "$APP_DIR/.db-env" ]; then
  DB_PASSWORD_RANDOM="$(openssl rand -hex 20)"
  if [ -n "${DB_PASSWORD:-}" ]; then
    DB_PASSWORD_RANDOM="$DB_PASSWORD"
  fi
  mysql -uroot <<SQL
CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '${DB_USER:-podvet}'@'localhost' IDENTIFIED BY '${DB_PASSWORD_RANDOM}';
GRANT ALL PRIVILEGES ON \`${DB_NAME}\`.* TO '${DB_USER:-podvet}'@'localhost';
GRANT ALL PRIVILEGES ON \`${DB_NAME}_clinic_%\`.* TO '${DB_USER:-podvet}'@'localhost';
GRANT CREATE, ALTER, DROP, SELECT, INSERT, UPDATE, DELETE, INDEX, REFERENCES
  ON \`${DB_PREFIX}%\`.* TO '${DB_USER:-podvet}'@'localhost';
CREATE USER IF NOT EXISTS '${DB_USER:-podvet}'@'127.0.0.1' IDENTIFIED BY '${DB_PASSWORD_RANDOM}';
GRANT ALL PRIVILEGES ON \`${DB_NAME}\`.* TO '${DB_USER:-podvet}'@'127.0.0.1';
GRANT ALL PRIVILEGES ON \`${DB_NAME}_clinic_%\`.* TO '${DB_USER:-podvet}'@'127.0.0.1';
CREATE USER IF NOT EXISTS '${DB_USER:-podvet}'@'%' IDENTIFIED BY '${DB_PASSWORD_RANDOM}';
GRANT ALL PRIVILEGES ON \`${DB_NAME}\`.* TO '${DB_USER:-podvet}'@'%';
GRANT ALL PRIVILEGES ON \`${DB_NAME}_clinic_%\`.* TO '${DB_USER:-podvet}'@'%';
FLUSH PRIVILEGES;
SQL
  umask 077
  {
    echo "DB_USER=${DB_USER:-podvet}"
    echo "DB_PASSWORD=${DB_PASSWORD_RANDOM}"
    echo "DB_NAME=${DB_NAME}"
    echo "DB_PREFIX=${DB_PREFIX}"
  } > "$APP_DIR/.db-env"
fi

# shellcheck disable=SC1091
. "$APP_DIR/.db-env"

# ── 3. Application install ───────────────────────────────────────────────────
mkdir -p "$APP_DIR"
cd "$APP_DIR"
[ -f package.json ] && npm install --omit=dev --no-fund --no-audit

# ── 4. Import schema (idempotent) ────────────────────────────────────────────
if [ -f "$APP_DIR/db/schema.sql" ]; then
  mysql -h"$DB_HOST" -P"$DB_PORT" -u"$DB_USER" -p"$DB_PASSWORD" "$DB_NAME" < "$APP_DIR/db/schema.sql"
fi

# ── 5. .env ──────────────────────────────────────────────────────────────────
cat > "$APP_DIR/.env" <<ENV
WEB_PORT=${APP_PORT}
DB_HOST=${DB_HOST}
DB_PORT=${DB_PORT}
DB_USER=${DB_USER}
DB_PASSWORD=${DB_PASSWORD}
DB_NAME=${DB_NAME}
DB_PREFIX=${DB_PREFIX}
DB_SSL=false
ENV

# ── 6. systemd service ───────────────────────────────────────────────────────
cat > /etc/systemd/system/podvet.service <<UNIT
[Unit]
Description=PodVet web server
After=network.target mysql.service
Wants=mysql.service

[Service]
Type=simple
WorkingDirectory=${APP_DIR}
ExecStart=/usr/bin/node ${APP_DIR}/index.js
Restart=always
RestartSec=5
EnvironmentFile=${APP_DIR}/.env
# The app resolves uploads relative to $HOME when APPDATA is unset:
Environment=HOME=/root

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable podvet.service
systemctl restart podvet.service || true

# ── 7. nginx reverse proxy ───────────────────────────────────────────────────
# Reuse already-issued certs: if a Let's Encrypt cert exists, write a server
# block that keeps HTTPS on all deploys (so certbot is only needed for the
# initial issuance). Otherwise write an HTTP-only block for certbot to upgrade.
CERT_DIR="/etc/letsencrypt/live/${DOMAIN}"
if [ -f "${CERT_DIR}/fullchain.pem" ]; then
  cat > /etc/nginx/sites-available/podvet <<NGINX
server {
    server_name ${DOMAIN};

    location / {
        proxy_pass http://127.0.0.1:${APP_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 300s;
    }

    listen 443 ssl; # managed by certbot template
    ssl_certificate ${CERT_DIR}/fullchain.pem;
    ssl_certificate_key ${CERT_DIR}/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
}
server {
    if (\$host = ${DOMAIN}) {
        return 301 https://\$host\$request_uri;
    }
    listen 80;
    server_name ${DOMAIN};
    return 404;
}
NGINX
  SKIP_CERTBOT=1
else
  cat > /etc/nginx/sites-available/podvet <<NGINX
server {
    listen 80;
    server_name ${DOMAIN};

    location / {
        proxy_pass http://127.0.0.1:${APP_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 300s;
    }
}
NGINX
fi
ln -sf /etc/nginx/sites-available/podvet /etc/nginx/sites-enabled/podvet
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx || systemctl restart nginx

# ── 8. Let's Encrypt (auto-HTTPS for podvet.biztrack.uk; DNS must be live) ──
if [ "${SKIP_CERTBOT:-0}" != "1" ]; then
  certbot --nginx -d "${DOMAIN}" --non-interactive --agree-tos --register-unsafely-without-email --redirect || echo "certbot failed - will retry on next deploy"
fi

echo "=== PodVet deploy complete: http://${DOMAIN} ==="