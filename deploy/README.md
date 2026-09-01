# Deployment

The workflows build `dist/` and publish it as a short-lived GitHub Actions artifact. The
manual workflow is intentionally a packaging template: it does not open an SSH session or
change infrastructure. Download the artifact from the workflow run and deploy `dist/` using
the approved hosting mechanism for this environment (Miaoda, a container platform, or an
internal release system).

The production process starts with `scripts/run.sh` from inside `dist/` and listens on
`SERVER_HOST` (default `0.0.0.0`) and `SERVER_PORT` (default `3000`). Keep platform credentials
and runtime configuration in the target platform's secret store; never commit `.env` files.

## Healthcheck

There is no generic `/health` endpoint in the application today. Use the deployed root URL
(`https://example.test/`) for a basic HTTP 200 check, or pass another unauthenticated endpoint
to the `healthcheck_url` input of `Deploy (manual template)`. The helper is also available
locally as `./deploy/healthcheck.sh https://example.test/`.

## Secrets and permissions

The workflows request only `contents: read` and do not require repository secrets. If a future
deployment adapter is added, use environment-scoped secrets and a narrowly scoped deploy token;
do not add private keys or long-lived credentials to workflow files. Review and pin any
third-party action upgrades before enabling automatic deployment.
