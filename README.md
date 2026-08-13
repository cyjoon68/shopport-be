# Shopport Backend

NestJS modular monolith for Shopport. The repository builds three deployment units: HTTP/GraphQL API, asynchronous worker, and image processor Lambda.

## Local development

```bash
corepack enable
pnpm install
pnpm db:migrate
pnpm dev
```

Required services are provided by the parent workspace Docker Compose stack. Copy `.env.example` to `.env` before starting.

## Commands

```bash
pnpm check
pnpm test
pnpm test:integration
pnpm build
```

`schema.graphql` is the canonical mobile API contract. Production schema changes use additive changes and deprecation before removal.

The API uses deterministic fake AI/catalog adapters in development and test. Production AI requests use the Command Code Provider API with zero data retention enforced. Crawling, HTML parsing, unofficial endpoints, and provider secrets in clients are prohibited.

## Production blockers

- `AI_MODE=commandcode` requires `COMMAND_CODE_API_KEY`. `COMMAND_CODE_MODEL` defaults to the vision-capable `gpt-5.4-mini`; Claude model IDs are rejected because they require Command Code's Anthropic Messages endpoint.
- `CATALOG_MODE=approved` requires an approved shopping provider adapter registration.
