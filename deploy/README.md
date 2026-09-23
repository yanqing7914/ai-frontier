# Deployment

The repository-wide development and release rules are documented in
`docs/development-workflow.md`. This file only documents the artifact layout
and deployment workflow details.

The workflows build `dist/` and publish it as a short-lived GitHub Actions artifact. The
`Deploy` workflow is a manual, environment-scoped SSH deployment; it changes only the
selected target's release symlink and systemd service. The older `Deploy (manual template)`
workflow remains a packaging-only example.

The production artifact uses a stable layout under `dist/`: compiled server code is in
`dist/server/`, Vite output (`index.html` and `assets/`) is in `dist/client/`, and
`dist/scripts/run.sh` is the
launcher. From the extracted artifact root, start it with `./scripts/run.sh` (or
`npm start` after installing the declared dependencies). It listens on `SERVER_HOST`
(default `0.0.0.0`) and `SERVER_PORT` (default `3000`). Keep platform credentials and
runtime configuration in the target platform's secret store; never commit `.env` files.

For the scoring service backed by LiteLLM, configure
`AI_PROVIDER_PROTOCOL=openai` explicitly. The application defaults to the
legacy capability protocol so existing deployments are not silently changed.

## Healthcheck

The application exposes an unauthenticated `/health` endpoint. Use
`https://example.test/health` for a basic HTTP 200 liveness check, or pass another
unauthenticated endpoint to the `healthcheck_url` input of `Deploy (manual template)` or set
`HEALTHCHECK_URL` on the environment used by `Deploy`.
The helper is also available locally as `./deploy/healthcheck.sh
https://example.test/health`.

## Secrets and permissions

The workflows request only `contents: read`. The SSH deployment requires the environment-scoped
secrets listed below; do not add private keys or long-lived credentials to workflow files. Review
and pin any third-party action upgrades before enabling deployment.
## GitHub deployment workflow

The repository now includes `.github/workflows/deploy.yml`. It is deliberately
manual: choose `staging` or `production` and a Git ref from Actions. Each
environment must define these GitHub Environment secrets:

- `DEPLOY_HOST`
- `DEPLOY_USER`
- `DEPLOY_PORT` (optional; defaults to `22`)
- `DEPLOY_PATH`
- `DEPLOY_SSH_KEY`
- `DEPLOY_SERVICE` (optional; defaults from the selected environment)
- `DEPLOY_SYSTEMD_SCOPE` (optional; defaults to `user`, or set to `system` for a system unit)
- `HEALTHCHECK_URL` (optional)

The target host must already have Node.js 22+, the environment `.env`, and an
enabled `ai-frontier-staging.service` or `ai-frontier-production.service`
systemd unit. The workflow defaults to user-level systemd (`systemctl --user`)
to match the single-host setup; set `DEPLOY_SYSTEMD_SCOPE=system` only when the
target uses system-level units. Set `DEPLOY_SERVICE` explicitly per environment
when the unit name is not the default. The workflow refuses to start an unmanaged process.
It creates an immutable release directory named for the commit SHA, updates
`current` only after extraction, restarts the selected service, and checks
`/health` when `HEALTHCHECK_URL` is configured. If restart fails, it restores
the previous `current` link.

Configure separate GitHub Environments named `staging` and `production` with
different hosts, paths, secrets, and approval rules. No deployment secret or
runtime `.env` belongs in Git.
