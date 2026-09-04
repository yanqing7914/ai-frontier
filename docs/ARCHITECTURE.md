# AI Frontier Architecture

`ai-frontier-client/` is the only canonical project. It contains the React/Vite
client, NestJS server, shared contracts, tests, and deployment notes.

The server keeps a 12-stage observable collection pipeline. The eight
post-processing roles are contract-bound handlers in
`server/modules/collector/agents/` and `server/modules/collector/architecture/`:

1. `content_filter` - content screening
2. `content_evaluator` - evidence and quality evaluation
3. `chinese_processor` - Chinese processing
4. `body_organizer` - body normalization
5. `event_recognizer` - event extraction
6. `semantic_clusterer` - semantic clustering
7. `event_reviewer` - quality review
8. `featured_explainer` - publish-ready explanation

Role dependencies, failure policies, evidence requirements, and idempotency
scopes are defined once in `contracts.ts`. Runtime handlers are injected and
cannot call a platform SDK or expose credentials by default.

Development boundaries:

- `client/` talks to the server through `client/src/api/`.
- `server/` owns HTTP, persistence, collection, and processing.
- `shared/` owns types and API contracts shared by both sides.
- `test/` contains regression and contract tests.
- `legacy/` and `archive/` are outside this repository and are reference-only.
