# CLAUDE.md

Guidance for working in this repo. The authoritative architecture context is **`backend.md`** — read it for full detail; this file is the operational summary.

## What this is

**GastronomIA backend** — multi-tenant SaaS for restaurant profitability (UPC thesis, Motif Restobar). NestJS modular monolith for business logic + a separate FastAPI service for AI (forecasting + Text-to-SQL). This repo is the **NestJS app** (`apps/api` role in the eventual monorepo). Code in English, docs in Spanish.

## Stack (reconciled with `backend.md` §2)

| Layer | Choice |
|---|---|
| Runtime / pkg manager | **Bun** (`bun.lock` is the source of truth — do not introduce npm/yarn lockfiles) |
| Framework | **NestJS 11 + Fastify** (`@nestjs/platform-fastify`) |
| Language | **TypeScript strict** (`strict: true`) — **`any` is forbidden** (`no-explicit-any: error`, ABET SO7 evidence) |
| ORM | **Prisma 6** (`prisma-client-js` generator, `env("DATABASE_URL")`) |
| DB | PostgreSQL 17 (Neon), pgvector for RAG |
| Tests | **Vitest + Supertest** (SWC transforms decorators) |
| Cache/queues | Upstash Redis + BullMQ (`ioredis` present) |

> Historical note: the initial scaffold shipped Express + Jest + Prisma 7; it was reconciled to Fastify + Vitest + Prisma 6 to match the signed architecture. Keep new code on this stack.

## Commands

```bash
bun install            # install deps (respects bun.lock)
bun run start:dev      # run with watch
bun run build          # nest build (tsc, strict)
bun run test           # unit tests (Vitest, src/**/*.spec.ts)
bun run test:e2e       # e2e tests (Vitest, test/**/*.e2e-spec.ts)
bun run test:cov       # coverage
bun run lint           # eslint --fix
bun run format         # prettier
bunx prisma migrate dev   # DB migrations (needs DATABASE_URL in .env)
```

Copy `.env.example` → `.env` before running anything that touches the DB.

## Architecture & boundaries (`backend.md` §3, §5)

- **Modular monolith**: one NestJS module per bounded context (`auth`, `tenants`, `catalog`, `bom`, `pos`, `billing`, `inventory`, `costing`, `reports`, `forecasting-orchestrator`, `chat-orchestrator`, `notifications`, `ingestion`, `platform`).
- Modules communicate **only via TypeScript interfaces** — **no cross-module imports** (enforce with `no-restricted-imports`).
- NestJS orchestrates; **FastAPI infers**. Heavy calls go async via **BullMQ**; results via polling or SSE.
- API is **REST + SSE** (no GraphQL). Response envelope `ApiResponse<T>` and all contracts live in `packages/shared` as **Zod** schemas (single source of truth; Pydantic mirrors on the Python side).

## Multi-tenancy — CRITICAL (risk R4, `backend.md` §4)

Cross-tenant leakage is the highest-severity failure in the project. Defense-in-depth:

1. **`tenant_id` ALWAYS comes from the JWT claim** — never from path, query, or body.
2. **RLS FORCE** on every business table; NestJS runs `SET LOCAL app.tenant_id = '<uuid>'` at the start of each HTTP transaction.
3. Every business table has `tenant_id UUID NOT NULL`; soft-delete via `deleted_at`. A dedicated RLS test suite must cover 4 vectors (cross-read, cross-write, JWT bypass, schema-owner bypass) **before** any business feature.

Authorization is fine-grained with **CASL** (gate actions, not just UI). Roles: `owner`, `manager`, `staff`.

## Conventions (`backend.md` §6, §11)

- **SDD (Spec-Driven Development)**: spec first → red test → minimal impl → review. No merge without a spec.
- Branches `feat/HU-XX-YY-titulo`; commits `spec(HU-XX-YY): ...` for spec work (`chore:` / `docs:` / `build:` for setup).
- Naming: camelCase vars/functions, PascalCase types/classes, **kebab-case filenames**.
- **Forbidden**: `any`, `console.log` (use a structured logger), silent catch, magic strings/numbers, hardcoded credentials, `tenant_id` from path/query/body, cross-module imports.
- DB naming `snake_case`; money is **PEN only**; timezone **America/Lima**.

## First steps for backend work (`backend.md` §13)

1. `platform` module skeleton (E12) + `packages/shared` Zod schemas (`ApiResponse`, auth, tenant).
2. `auth` + `tenants` (E01): JWT RS256 + `SET LOCAL app.tenant_id` + the 4-vector RLS suite.
3. Base Prisma migration with a `@TenantScoped` decorator → RLS FORCE policy generator.
4. FastAPI stub (`/forecast/run`, `/chat/query`) behind the REST contract + BullMQ queue.
