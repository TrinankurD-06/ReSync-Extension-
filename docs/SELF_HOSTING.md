# Self-hosting the ReSync team server

The team server is optional: the plugin, CLI and extension all work offline without it. It adds accounts, invite-only teams, shared team prompts with version history, a usage dashboard, queue reports, and shared handoffs. One process serves both the API and the dashboard.

There are two ways to run it, both at Rs 0: **Docker** on any machine, or **free cloud tiers** (MongoDB Atlas M0 + Render). Free-tier limits were checked on 2026-10-17 and are recorded in [VERIFIED.md](VERIFIED.md).

## 1. Local trial with Docker (2 minutes)

```sh
docker compose up --build
```
Open <http://localhost:8787>. This trial:

- listens on **127.0.0.1 only**, so it isn't reachable from your network;
- uses a **development sign-in** (just an email, no password, no OAuth app);
- stores data in the `resync-mongo` Docker volume.

**Never expose this mode publicly.** For real use, continue below.

## 2. Production with Docker

1. **Create an OAuth app** (GitHub, Google, or both). See section 4.
2. **Create a `.env` file** next to `docker-compose.yml`:
   ```env
   NODE_ENV=production
   PUBLIC_SERVER_URL=https://resync.yourteam.example
   DASHBOARD_URL=https://resync.yourteam.example
   SESSION_SECRET=<64 random hex characters>   # node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ALLOW_DEV_LOGIN=false
   GITHUB_CLIENT_ID=...
   GITHUB_CLIENT_SECRET=...
   # GOOGLE_CLIENT_ID=... / GOOGLE_CLIENT_SECRET=...
   CORS_ORIGINS=chrome-extension://<your-extension-id>
   RESYNC_BIND=0.0.0.0          # listen on all interfaces (put it behind HTTPS!)
   TRUST_PROXY=true            # when behind a reverse proxy that sets X-Forwarded-For
   ```
   In production the server refuses to start with a weak `SESSION_SECRET` or with dev login on.
3. **Run `docker compose up -d --build`** behind an HTTPS reverse proxy (Caddy, nginx, Traefik). Session cookies are marked `Secure` in production.
4. **Open the URL and sign in.** The first person creates the team and becomes its owner, then invites the others.

**Finding your extension ID** (for `CORS_ORIGINS`): `chrome://extensions` > ReSync > ID. The extension calls the server from its service worker, which Chrome lets through with host permission, but listing the origin is still correct.

## 3. Free cloud: MongoDB Atlas M0 + Render

**Database: MongoDB Atlas M0 (free).**

1. Create a free cluster at <https://www.mongodb.com/cloud/atlas>. M0 gives 512 MB storage and 100 ops/s, and pauses after 30 days without connections.
2. Create a database user, and allow access from anywhere (`0.0.0.0/0`, because Render's IPs vary) or from Render's outbound IPs.
3. Copy the connection string, e.g. `mongodb+srv://user:pass@cluster0.xxxxx.mongodb.net/resync`.

**Server and dashboard: Render (free web service).**

1. Push your fork to GitHub, then on <https://render.com> create a **Web Service** from the repo.
2. **Runtime:** Docker (it uses the repo's `Dockerfile`).
3. **Environment variables:** everything from section 2, plus:
   - `MONGODB_URI` set to the Atlas string;
   - `PUBLIC_SERVER_URL` and `DASHBOARD_URL` set to your `https://<name>.onrender.com`;
   - `TRUST_PROXY=true`.
4. **Health check path:** `/api/v1/health`.

Free services sleep after 15 minutes without traffic, and the first request then takes about a minute. That's fine for ReSync, because the CLI and extension work offline and only sync.

**Alternative: Koyeb**, which offers one free instance that sleeps after an hour idle. Fly.io and Railway no longer have lasting free tiers.

## 4. OAuth apps

**GitHub** (<https://github.com/settings/developers> > OAuth Apps > New):

- Homepage URL: `https://resync.yourteam.example`
- Authorization callback URL: `https://resync.yourteam.example/api/v1/auth/github/callback`
- Put the Client ID and a new Client Secret in `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`.
- Scopes used: `read:user user:email`. Users are keyed on their GitHub numeric id, not their email.

**Google** (<https://console.cloud.google.com/apis/credentials> > Create credentials > OAuth client ID > Web application):

- Authorized redirect URI: `https://resync.yourteam.example/api/v1/auth/google/callback`
- Put the values in `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`.
- Scopes used: `openid email profile`. Users are keyed on the Google `sub`.

Both flows use `state` and PKCE (S256). Only configured providers appear on the sign-in page.

## 5. Operations

- **Health:** `GET /api/v1/health` returns `{ "ok": true }`.
- **Logs:** structured JSON (pino) to stdout: method, path, status, duration, user id. Request bodies, tokens and cookies are never logged.
- **Backups:** use `mongodump` for the `resync` database, or Atlas backups.
- **Rate limits:** 600 requests / 15 min per IP, and 60 / 15 min on sign-in endpoints.
- **Data controls for users:** export everything as JSON and delete their account (dashboard > Your data). Owners can delete the team.
- **Upgrading:** `git pull && docker compose up -d --build`. There are no migrations; Mongoose creates indexes on start.

## Configuration reference

All configuration comes from environment variables (see `.env.example`):

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8787` | Port inside the container or process |
| `MONGODB_URI` | `mongodb://localhost:27017/resync` | Database |
| `PUBLIC_SERVER_URL` | `http://localhost:8787` | Base for OAuth callback URLs |
| `DASHBOARD_URL` | `http://localhost:5173` | Redirect target after sign-in; allowed CORS origin |
| `CORS_ORIGINS` | | Extra allowed origins, comma separated (extension IDs) |
| `SESSION_SECRET` | | Signs cookies; 32+ characters required in production |
| `GITHUB_CLIENT_ID` / `_SECRET` | | GitHub sign-in |
| `GOOGLE_CLIENT_ID` / `_SECRET` | | Google sign-in |
| `ALLOW_DEV_LOGIN` | `false` | Development-only email sign-in (refused in production) |
| `SERVE_DASHBOARD` | | Folder of the built dashboard to serve (set in the Docker image) |
| `TRUST_PROXY` | `false` | Trust `X-Forwarded-*` from one proxy hop |
| `LOG_LEVEL` | `info` | pino log level |
