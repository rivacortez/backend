# HU-07-11/12 — Menu Engineering y Prime Cost

> **Épica:** E07 (Reportes, Dashboards y KPIs) · **Sprint:** S4/S5 · **Must** · **Estado:** 🟢 hecho (Inc 3).
> **Increment 3** de E07 — dos endpoints analíticos de alto valor que transforman el producto de "registra datos" a "le dice al dueño qué hacer". Sin tablas nuevas ni migración (agregación read-only). Construye sobre E04 (`sales`), E05 (`overhead_costs`) y E06 (BOM de ingredientes vía `RecipesService`).

Extiende el módulo **`reports`** (`src/reports/`): se añaden dos GET analíticos a `ReportsController`/`ReportsService`. La lógica de clasificación (pura, sin IO) vive en `src/reports/menu-engineering.util.ts` — unit-testable de forma aislada. Se respeta la frontera de módulos: datos leídos directamente vía `runInTenant`; única dependencia inyectada sigue siendo `RecipesService` (exportado por `CatalogModule`).

---

## CASL — por endpoint (sin cambios en la matriz)

Ambos endpoints son información de gestión (análisis de margen y KPI del negocio):

- **Menu Engineering + Prime Cost** → `@RequireAbility('read', 'Report')` (owner + manager; **staff → 403**).

No se añade sujeto ni cambia `casl-ability.factory.ts`.

---

## Período por defecto

Los endpoints analíticos toman `?period=YYYY-MM` **opcional**. Si se omite, se usa el **último mes completo** en la zona del tenant (America/Lima, UTC-5): función `lastCompletePeriod()` en `report-window.util.ts`. Consistente con cómo `CostingService.dishes()` defaúltea en el seed de demo.

---

## HU-07-11 · Menu Engineering — `GET /api/reports/menu-engineering?period=YYYY-MM`

```gherkin
Dado un propietario autenticado
Cuando consulta el análisis de ingeniería de menú del período
Entonces ve cada ítem del menú clasificado en la matriz Kasavana-Smith
Y recibe una recomendación accionable por plato
Y puede identificar cuáles platos impulsar, represar, reposicionar o eliminar
```

Implementa la **matriz Kasavana-Smith** (popularidad × margen de contribución):

### Contrato de respuesta

```jsonc
{
  "period": "2026-06",
  "popularityCutoff": "0.3500", // 0.70 × (1/N), 4 decimales
  "avgContributionMargin": "22.50", // promedio simple de CM entre N ítems, 2 decimales
  "items": [
    {
      "menuItemId": "<uuid>",
      "name": "Ceviche Especial",
      "category": "Pescados", // nombre de menuCategory; null si no tiene categoría
      "unitsSold": 90,
      "price": "42.00", // precio de venta (PEN, string)
      "foodCost": "9.50", // costo de ingredientes por unidad (BOM recursivo)
      "contributionMargin": "32.50", // price − foodCost
      "totalContribution": "2925.00", // contributionMargin × unitsSold
      "popularityShare": "0.9000", // unitsSold / totalUnits (4 decimales)
      "classification": "star", // star | plowhorse | puzzle | dog
      "recommendation": "promote", // ver tabla debajo
    },
  ],
}
```

### Fórmulas y reglas de clasificación

| Campo                   | Definición                                                                                                                                                                    |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `foodCost`              | Costo de ingredientes por unidad via BOM recursivo (`RecipesService.costPerYieldTx`). **NO incluye CIF** (la ingeniería de menú usa el margen directo, no el costo completo). |
| `contributionMargin`    | `price − foodCost` (margen de contribución directo)                                                                                                                           |
| `popularityCutoff`      | `0.70 × (1 / N)` donde N = número de ítems activos en el análisis. Umbral estándar Kasavana-Smith.                                                                            |
| `avgContributionMargin` | Promedio **simple** (no ponderado por unidades) de los N `contributionMargin`. Este promedio define la frontera de "alta rentabilidad".                                       |
| **Alta popularidad**    | `popularityShare ≥ popularityCutoff`                                                                                                                                          |
| **Alta rentabilidad**   | `contributionMargin ≥ avgContributionMargin`                                                                                                                                  |

Matriz:

| Popularidad | Rentabilidad | Clasificación | Recomendación               |
| ----------- | ------------ | ------------- | --------------------------- |
| Alta        | Alta         | `star`        | `promote`                   |
| Alta        | Baja         | `plowhorse`   | `reprice_or_reduce_portion` |
| Baja        | Alta         | `puzzle`      | `reposition_or_rename`      |
| Baja        | Baja         | `dog`         | `remove_or_rework`          |

### Casos borde

- **N = 0** (sin ítems activos): `items: []`, `popularityCutoff: '0.0000'`, `avgContributionMargin: '0.00'`.
- **totalUnits = 0** (período sin ventas): `popularityShare = '0.0000'` para todos → todos de baja popularidad; clasificación determinada solo por `contributionMargin` vs `avgContributionMargin`.

---

## HU-07-12 · Prime Cost — `GET /api/reports/prime-cost?period=YYYY-MM`

```gherkin
Dado un propietario autenticado
Cuando consulta el prime cost del período
Entonces ve el costo combinado de alimentos + mano de obra como % del revenue
Y puede comparar contra los benchmarks de la industria (55–65% saludable)
Y tiene un semáforo (good/warning/high) para actuar
```

**Prime Cost** = KPI #1 de rentabilidad restaurantera (costo de comida + mano de obra como % del revenue).

### Contrato de respuesta

```jsonc
{
  "period": "2026-06",
  "revenue": "85000.00", // Σ Sale.total de ventas issued en el período (incluye IGV)
  "foodCost": "22000.00", // Σ (unitsSold × ingredientCost) teórico por plato
  "foodCostPct": "25.88", // foodCost / revenue × 100
  "laborCost": "9850.00", // Σ overhead_costs con concept ILIKE '%sueld%' en el período
  "laborCostPct": "11.59", // laborCost / revenue × 100
  "primeCost": "31850.00", // foodCost + laborCost
  "primeCostPct": "37.47", // primeCost / revenue × 100
  "status": "good", // good (≤60%) | warning (60–65%) | high (>65%)
  "benchmarks": {
    "primeCostGoodMax": "60.00",
    "primeCostWarningMax": "65.00",
    "foodCostGoodMin": "28.00",
    "foodCostGoodMax": "35.00",
    "laborCostGoodMin": "25.00",
    "laborCostGoodMax": "35.00",
    "foodCostStatus": "good", // good (≤35%) | warning (≤40%) | high (>40%)
    "laborCostStatus": "good", // good (≤35%) | warning (≤40%) | high (>40%)
  },
}
```

### Definiciones

| Campo             | Definición                                                                                                                                                                           |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `revenue`         | Σ `Sale.total` de ventas `issued` con `issuedAt ∈ [inicio_mes, fin_mes)`. Incluye IGV — base consistente con todos los reportes de ventas.                                           |
| `foodCost`        | `Σ por plato activo: unitsSold × ingredientCost` (costo teórico del BOM × unidades vendidas). Misma lógica que `CostingService.dishes()`.                                            |
| `laborCost`       | Σ `overhead_costs.amount` del período con `concept ILIKE '%sueld%'`. Convención de nomenclatura del tenant: la línea "Sueldos de planilla" identifica el componente de mano de obra. |
| `primeCost`       | `foodCost + laborCost`                                                                                                                                                               |
| `status`          | `good` si `primeCostPct ≤ 60`; `warning` si `≤ 65`; `high` si `> 65`. Benchmark industria: 55–65% saludable.                                                                         |
| `foodCostStatus`  | `good` si `foodCostPct ≤ 35`; `warning` si `≤ 40`; `high` si `> 40`.                                                                                                                 |
| `laborCostStatus` | `good` si `laborCostPct ≤ 35`; `warning` si `≤ 40`; `high` si `> 40`.                                                                                                                |

### Casos borde

- **revenue = 0**: todos los `%Pct = '0.00'`; `status = 'good'` (no hay actividad).
- **Sin overhead de labor en el período**: `laborCost = '0.00'`; prime cost = solo food cost.

---

## Frontera de módulos

`ReportsService` lee directamente vía `runInTenant`: `sales`, `order_items`, `menu_items`, `overhead_costs`. Única dependencia inyectada de otro contexto: `RecipesService` (BOM recursivo). `tenant_id` siempre desde el JWT. No se importan servicios de `costing` ni de otros módulos.

---

## Pruebas — `test/reports-analytics.e2e-spec.ts` (nuevo)

Siembra un tenant + owner/staff, 2 ingredientes (Queso: unitCost=10; Salmón: unitCost=30), 2 recetas (ComboRecipe: 1kg Queso → ingredientCost=10; AguaRecipe: 0.5kg Salmón → ingredientCost=15), 2 platos (Combo Premium: price=50; Agua Mineral: price=20), 1 overhead de planilla (amount=500) y 2 ventas del período (9×Combo + 1×Agua).

### Asserts — Menu Engineering

- `view.period` = PERIOD actual.
- `view.popularityCutoff` = '0.3500' (0.70 × 0.5).
- `view.avgContributionMargin` = '22.50' ((40+5)/2).
- "Combo Premium" → `classification='star'`, `recommendation='promote'`, `contributionMargin='40.00'`, `totalContribution='360.00'`, `popularityShare='0.9000'`.
- "Agua Mineral" → `classification='dog'`, `recommendation='remove_or_rework'`, `contributionMargin='5.00'`, `totalContribution='5.00'`, `popularityShare='0.1000'`.
- Al menos un `star` y un `dog` en los items.

### Asserts — Prime Cost

- `view.revenue` = '470.00' (9×50 + 1×20).
- `view.foodCost` = '105.00' (9×10 + 1×15).
- `view.laborCost` = '500.00'.
- `view.primeCost` = '605.00'.
- `view.status` = 'high' (128.72% > 65%).
- Spot-check: `Number(view.primeCostPct)` ≈ `Number(view.primeCost) / Number(view.revenue) × 100`.
- `view.benchmarks.primeCostGoodMax` = '60.00'.

### Asserts — RBAC y autenticación

- `staff` → **403** en ambos endpoints.
- Sin token → **401** en ambos endpoints.
- Default period (sin `?period`): ambos endpoints → **200** (no error aunque el mes anterior no tenga datos).

### Unit tests — `src/reports/menu-engineering.util.spec.ts`

- `classifyDish`: 4 cuadrantes + 2 boundaries (popularityShare == cutoff, CM == avgCM).
- `recommendationFor`: mapea correctamente los 4 cuadrantes.
- `POPULARITY_FACTOR` = 0.70.
- N=1: ítem con ventas → `star`.
