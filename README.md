# Shopport Backend

Shopport의 NestJS modular monolith입니다. HTTP/GraphQL API, 비동기 worker, image processor Lambda를 하나의 도메인 모델과 계약으로 운영합니다.

## 역할

GraphQL은 조회와 일반 mutation을, /v1/ai/chat은 TanStack AI NDJSON stream을 담당합니다. 별도 BFF는 두지 않으며, API·worker·image Lambda만 배포 단위로 나눕니다.

## 실행하기

Node.js 22.13 이상과 Corepack이 필요합니다.

```bash
corepack enable
pnpm install
cp .env.example .env
pnpm db:migrate
pnpm dev
```

명령은 이 저장소의 .env를 읽습니다. PostgreSQL, LocalStack 등 로컬 의존 서비스와 Compose 기반 API·worker 실행은 [통합 워크스페이스](https://github.com/cyjoon68/shopport-app)의 make dev-core에서 제공합니다.

```bash
pnpm dev:worker
pnpm dev:outbox-worker
```

위 명령은 API와 분리해 worker 또는 outbox dispatcher만 실행할 때 사용합니다.

## 배포 단위

| 단위                   | 책임                                               |
| ---------------------- | -------------------------------------------------- |
| HTTP/GraphQL API       | 인증, GraphQL, AI stream, catalog 조회, asset 요청 |
| Worker                 | 비동기 job, outbox, 검색 색인, 보존 처리           |
| Image processor Lambda | S3 asset을 정규화하고 결과를 queue로 전달          |

## API와 데이터 계약

schema.graphql은 모바일의 canonical API contract입니다. production schema는 additive 변경 후 deprecation을 거쳐 제거합니다. threadId는 conversation ID이고 runId는 idempotency key이며, PostgreSQL stream event는 1시간 보관합니다.

## Provider와 보안 경계

상품 검색은 승인된 catalog API 또는 licensed feed만 사용합니다. crawling, HTML parsing, 비공식 endpoint, client에 provider secret을 넣는 방식은 금지합니다. 승인된 adapter가 없으면 fail-closed합니다.

AI는 Command Code Provider API의 OpenAI Chat Completions 호환 endpoint만 사용하고 x-cmd-zdr: 1을 강제합니다. ZDR-capable upstream이 없으면 비보존 경로로 fallback하지 않고 실패합니다. production에서는 PROVIDER_API_KEY가 필요하며, 기본 모델은 vision-capable gpt-5.4-mini입니다.

## 검사

```bash
pnpm check
pnpm test
pnpm test:integration
pnpm build
```

## 관련 문서

- [통합 워크스페이스](https://github.com/cyjoon68/shopport-app)
- [Provider 승인 정책](https://github.com/cyjoon68/shopport-app/blob/develop/docs/providers.md)
- [AI provider](https://github.com/cyjoon68/shopport-app/blob/develop/docs/ai-provider.md)
