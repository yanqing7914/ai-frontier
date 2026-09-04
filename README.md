# AI Frontier

AI Frontier is an internal NestJS + React application for collecting, scoring,
reviewing, and publishing AI industry news.

## Local development

Requirements: Node.js 22+ and npm 10+.

```sh
npm ci --ignore-scripts
cp .env.example .env.local
npm run dev:local
```

Useful checks:

```sh
npm run lint
npm test -- --runInBand
npm run build:prod
```

The server listens on `SERVER_HOST` and `SERVER_PORT` (default `0.0.0.0:3000`).
Keep database URLs, API keys, and platform credentials in the local or hosting
secret store; do not commit `.env` files.

## Repository layout

- `client/` - React/Vite frontend
- `server/` - NestJS API and collection pipeline
- `shared/` - shared contracts and direction definitions
- `test/` - unit and integration tests
- `deploy/` - packaging and healthcheck notes

See `deploy/README.md` for the current artifact-based deployment process.
