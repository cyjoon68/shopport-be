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

The API exposes only deterministic fake AI/catalog adapters in development and test. Production fails closed until an approved provider adapter and a configured multimodal LLM are supplied. Crawling, HTML parsing, unofficial endpoints, and provider secrets in clients are prohibited.
