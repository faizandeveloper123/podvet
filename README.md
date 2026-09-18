# PodVet — standalone web edition (v5.0.10-web)

Pure Node/Express, no Electron runtime. The same React frontend (`public/`) and
handler logic (`handlers/*.js`) as the desktop build, with a pure-Node
`electron` compat shim so nothing touches Chromium.

## Run locally

```bash
npm install
node index.js          # http://localhost:8080
```

`WEB_PORT` / `PORT` override the port. Default login: `admin` / `admin123`.

## Database

PodVet is fully isolated from any shared MySQL: it creates its own platform
database (`DB_NAME`, default `podvet`) and its own per-clinic databases
(`DB_PREFIX` + clinic id, default `podvet_clinic_`). It never touches an
existing `podvet` / `clinic_*` database.

Bootstrap the platform schema on a fresh MySQL server:

```bash
mysql -u podvet -p podvet < db/schema.sql
```

Environment variables (see `.env.example`):

| Var            | Meaning                              | Default          |
|----------------|--------------------------------------|------------------|
| `WEB_PORT`     | HTTP port                            | `8080`           |
| `DB_HOST`      | MySQL host                           | `localhost`      |
| `DB_PORT`      | MySQL port                           | `3306`           |
| `DB_USER`      | MySQL user                           | `root`           |
| `DB_PASSWORD`  | MySQL password                       | ``               |
| `DB_NAME`      | PodVet platform database             | `podvet`         |
| `DB_PREFIX`    | PodVet clinic database prefix        | `clinic_`        |
| `DB_SSL`       | Set `true` for TLS to MySQL          | unset            |

> For an isolated deployment set `DB_NAME=podvet` and `DB_PREFIX=podvet_clinic_`
> so the app can never collide with an existing shared `podvet` database. The
> repository's `db/schema.sql` already targets the `podvet` database.

## Deploy

A GitHub Actions workflow (`.github/workflows/deploy.yml`) deploys the app to a
Linux VPS on every push to `main`. It uses these repository secrets:

- `ACCESS_KEY` — SSH **private key** for the VPS (`root` user)
- `SECRET_KEY` — passphrase of that key (leave unset if none)
- `VPS_HOST` — server IP or hostname (optional, default `81.17.101.93`)
- `VPS_USER` — SSH user (optional, default `root`)
- `VPS_PORT` — SSH port (optional, default `22`)
- `DB_PASSWORD` — MySQL password for the isolated `podvet` user (optional; a
  random one is generated and persisted on the server on first deploy?)

The workflow:
1. Copies the code to `/opt/podvet` on the VPS.
2. Installs the app with `npm install --omit=dev`.
3. Ensures the `podvet` MySQL database + `podvet` MySQL user exist (grants are
   limited to `podvet` and `podvet_clinic_*`, so other databases are untouched).
4. Imports `db/schema.sql` into the `podvet` database (idempotent).
5. Writes `/opt/podvet/.env` (from secrets) and runs the app with `systemd`
   on port `8080`.
6. Configures an nginx reverse proxy for `podvet.biztrack.uk` -> `127.0.0.1:8080`
   and requests a Let's Encrypt certificate (certbot).

One-time server provisioning is handled by `deploy/setup-server.sh` (installs
Node.js, MySQL, npm, nginx, certbot if missing).

See `deploy/` for the systemd unit and nginx site config.