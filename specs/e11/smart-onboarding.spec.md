# Spec E11-SO — Smart Onboarding: Carga inteligente de documentos del restaurante

**Estado:** `spec_ready`
**Sprint:** S1 (HU-11-06/07/08)
**Autor:** Backend Agent
**Fecha:** 2026-07-01

---

## 1. Contexto

Un restaurante nuevo que se registra en GastronomIA debe cargar su menú e insumos
manualmente, lo que crea fricción de adopción. Este feature permite subir un PDF
de la carta o un Excel/CSV con platos e insumos, extraer los datos con IA (core-ai)
y pre-cargar el catálogo del tenant en dos pasos: **preview** (sin escribir nada)
y **commit** (el usuario confirma y se crean los registros).

**Flujo de valor:** onboarding en < 5 min → retención temprana → evidencia OE3.

---

## 2. Alcance

| Tipo              | Incluido                                                   |
| ----------------- | ---------------------------------------------------------- |
| Formatos          | PDF (carta), XLSX/XLS (Excel), CSV                         |
| Entidades creadas | `Ingredient`, `MenuCategory`, `Recipe` (stub), `MenuItem`  |
| Idempotencia      | re-commit no duplica por (tenant, name)                    |
| Precio            | solo PEN; negativos/absurdos rechazados                    |
| Venta histórica   | NO — usar el flujo E11 existente (`/sales-history/import`) |

---

## 3. Endpoints

### R1 — `POST /api/import/document/preview`

**EARS:** WHEN an owner/manager uploads a document file (PDF/xlsx/csv up to 10 MB),
THEN the system SHALL extract menu items and ingredients via AI and return a structured
preview WITHOUT writing any data to the database.

**Request:** `multipart/form-data`, campo `file`.
**Guard:** `manage Catalog` → owner + manager; staff → 403.
**Response:** `ApiResponse<DocumentPreviewResponse>` (HTTP 201):

```json
{
  "menuItems": [
    {
      "name": "Lomo Saltado",
      "price": 32.5,
      "category": "Platos",
      "description": null
    }
  ],
  "ingredients": [
    { "name": "Aceite vegetal", "unit": "litro", "estimatedCost": 8.5 }
  ],
  "source": { "type": "pdf", "filename": "carta.pdf" },
  "provider": "openai"
}
```

**Errores esperados:**

- 400: archivo faltante, tipo inválido, tamaño > 10 MB, archivo ilegible
- 503: core-ai no disponible (timeout/down)
- 504: core-ai no respondió en tiempo

### R2 — `POST /api/import/document/commit`

**EARS:** WHEN an owner/manager sends a (reviewed) preview payload,
THEN the system SHALL create in the tenant's catalog only the items that do not
already exist (idempotency by name), inside `runInTenant`, and return a creation
summary.

**Request:** JSON `{ menuItems: [...], ingredients: [...] }`.
**Guard:** `manage Catalog` → owner + manager; staff → 403.
**Response:** `ApiResponse<DocumentCommitResponse>` (HTTP 201):

```json
{
  "created": { "ingredients": 2, "menuItems": 3, "categories": 1 },
  "skipped": ["Lomo Saltado"]
}
```

**Invariantes de negocio:**

- `price` ≥ 0 y ≤ 9 999 (precios absurdos rechazados → 400).
- `estimatedCost` ≥ 0 si presente.
- `tenant_id` SIEMPRE del JWT (nunca del body).
- Todo dentro de `runInTenant` → RLS FORCE cubre.

---

## 4. core-ai — `POST /extract/document`

**EARS:** WHEN core-ai receives a document text with a target ('menu'|'ingredients'|'auto'),
THEN the LLM SHALL return a structured JSON of extracted items, being conservative
(never inventing prices; if uncertain → omit).

**Request:**

```json
{ "text": "...", "target": "auto", "currency": "PEN" }
```

**Response:**

```json
{"menuItems": [...], "ingredients": [...], "provider": "openai", "model": "gpt-4o-mini"}
```

**Mock:** retorna 3 platos + 2 insumos fijos (determinístico; no necesita API key).

---

## 5. Escenarios Gherkin

```gherkin
Feature: Smart Onboarding — carga de documentos

  Background:
    Given un tenant "Motif" con usuario owner "owner@motif.pe"
    And un usuario manager "manager@motif.pe"
    And un usuario staff "staff@motif.pe"

  # R1 — Preview
  Scenario: Preview de CSV válido devuelve menú extraído sin crear registros
    When el owner hace POST /import/document/preview con un CSV de platos
    Then recibe 201 con menuItems non-empty y source.type="csv"
    And la BD no tiene ningún MenuItem nuevo

  Scenario: Staff no puede hacer preview → 403
    When el staff hace POST /import/document/preview
    Then recibe 403

  Scenario: Tipo de archivo inválido → 400
    When el owner sube un .txt
    Then recibe 400

  # R2 — Commit
  Scenario: Commit crea MenuItem + Ingredient + Category
    Given el owner tiene un preview con 2 platos y 1 insumo
    When hace POST /import/document/commit con ese payload
    Then recibe 201 con created.menuItems=2, created.ingredients=1
    And los registros existen en BD bajo el tenant

  Scenario: Re-commit es idempotente (no duplica)
    Given un commit ya ejecutado con plato "Lomo Saltado"
    When se vuelve a hacer commit con el mismo payload
    Then created.menuItems=0 y skipped contiene "Lomo Saltado"

  Scenario: Commit con precio negativo → 400
    When el owner envía commit con price=-5
    Then recibe 400

  Scenario: Staff no puede hacer commit → 403
    When el staff hace POST /import/document/commit
    Then recibe 403

  # RLS
  Scenario: Items creados por tenant A no son visibles para tenant B
    Given dos tenants A y B, cada uno con owner
    When owner-A hace commit creando "Ceviche"
    Then owner-B consulta sus menu_items y NO ve "Ceviche"

  Scenario: Commit de tenant B no puede leer menu_items de tenant A
    Given tenant A tiene MenuItem "Lomo Saltado"
    When se hace runInTenant(tenantB) y se busca MenuItems
    Then el resultado es vacío (RLS FORCE aísla)
```

---

## 6. Trazabilidad

| Req                      | Test                                                   | Estado       |
| ------------------------ | ------------------------------------------------------ | ------------ |
| R1 preview CSV→201       | `import-document.e2e-spec.ts` — "preview"              | ROJO → VERDE |
| R1 staff→403             | `import-document.e2e-spec.ts` — "staff 403 preview"    | ROJO → VERDE |
| R1 tipo inválido→400     | `import-document.e2e-spec.ts` — "bad type 400"         | ROJO → VERDE |
| R2 commit crea entidades | `import-document.e2e-spec.ts` — "commit creates"       | ROJO → VERDE |
| R2 idempotencia          | `import-document.e2e-spec.ts` — "idempotent commit"    | ROJO → VERDE |
| R2 precio negativo→400   | `import-document.e2e-spec.ts` — "negative price 400"   | ROJO → VERDE |
| R2 staff→403             | `import-document.e2e-spec.ts` — "staff 403 commit"     | ROJO → VERDE |
| RLS cross-tenant         | `import-document.e2e-spec.ts` — "rls tenant isolation" | ROJO → VERDE |
| core-ai extract mock     | `test_extract.py` — mock path                          | ROJO → VERDE |
| core-ai malformed→empty  | `test_extract.py` — malformed text                     | ROJO → VERDE |
