# Shopport Backend

NestJS modular monolith for Shopport. The repository builds three deployment units: HTTP/GraphQL API, asynchronous worker, and image processor Lambda.

## Local development

```bash
corepack enable
pnpm install
cp .env.example .env
pnpm db:migrate
pnpm dev
```

Required services are provided by the parent workspace Docker Compose stack. Backend commands read this repository's `.env`.

## Commands

```bash
pnpm check
pnpm test
pnpm test:integration
pnpm build
```

`schema.graphql` is the canonical mobile API contract. Production schema changes use additive changes and deprecation before removal.

The API uses the Command Code Provider API and live catalog providers. Crawling, HTML parsing, unofficial endpoints, and provider secrets in clients are prohibited.

## Production blockers

- `PROVIDER_API_KEY` is required. `PROVIDER_MODEL` defaults to the vision-capable `gpt-5.4-mini`; Claude model IDs are rejected because they require Command Code's Anthropic Messages endpoint.
