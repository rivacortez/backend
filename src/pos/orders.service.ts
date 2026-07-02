import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../platform/prisma/prisma.service';
import {
  type AddOrderItemsInput,
  type ApplyDiscountInput,
  type OpenOrderInput,
  type UpdateOrderItemInput,
  type UpsellSuggestionsResponse,
  type VoidOrderInput,
} from '../shared';

type Tx = Prisma.TransactionClient;
type OrderRow = Prisma.OrderGetPayload<object>;
type OrderItemRow = Prisma.OrderItemGetPayload<object>;

// Snapshot de modificador embebido en el ítem (JSONB). priceDelta es number (PEN).
interface ModifierSnapshot {
  name: string;
  priceDelta: number;
}

// Estados desde los que se puede anular una orden (HU-03-11).
const VOIDABLE_STATUSES = new Set(['open', 'sent_to_kitchen', 'served']);

// Estados de una orden "viva" (la cuenta actual de una mesa ocupada).
const CURRENT_ORDER_STATUSES = ['open', 'sent_to_kitchen', 'served'];

// QA-02 (bugfix) · Estados sobre los que se puede aplicar/quitar un descuento:
// la cuenta debe seguir "viva" (no cobrada ni anulada) — mismo criterio que
// anular orden. Cobrar (`pay`) es lo que congela el descuento en el ticket.
const DISCOUNTABLE_STATUSES = new Set(['open', 'sent_to_kitchen', 'served']);

// Vista del descuento vigente en la orden (display; el cómputo monetario
// autoritativo vive en `computeDiscountAmount`, usado por billing al cobrar).
export interface OrderDiscountView {
  type: 'pct' | 'amount';
  value: string;
  reason: string;
}

// Resumen de la orden actual de una mesa (para enriquecer el listado de mesas).
export interface TableOrderSummary {
  currentOrderId: string;
  openedAt: string;
  guests: number;
  waiterId: string | null;
  waiterName: string | null;
}

export interface OrderItemView {
  id: string;
  menuItemId: string;
  name: string;
  qty: number;
  unitPrice: string;
  notes: string | null;
  modifiers: ModifierSnapshot[];
  status: string;
}

export interface OrderView {
  id: string;
  tableId: string;
  waiterId: string | null;
  waiterName: string | null;
  guests: number;
  status: string;
  openedAt: string;
  items: OrderItemView[];
  subtotal: string;
  // QA-02 (bugfix) · Descuento vigente en la cuenta (null si no se aplicó).
  discount: OrderDiscountView | null;
}

function itemToView(item: OrderItemRow): OrderItemView {
  return {
    id: item.id,
    menuItemId: item.menuItemId,
    name: item.name,
    qty: item.qty,
    unitPrice: item.unitPrice.toFixed(2),
    notes: item.notes,
    modifiers: item.modifiers as unknown as ModifierSnapshot[],
    status: item.status,
  };
}

function toView(
  order: OrderRow,
  items: OrderItemRow[],
  waiterName: string | null,
): OrderView {
  let subtotal = new Prisma.Decimal(0);
  for (const item of items) {
    subtotal = subtotal.add(item.unitPrice.mul(item.qty));
  }
  return {
    id: order.id,
    tableId: order.tableId,
    waiterId: order.waiterId,
    waiterName,
    guests: order.guests,
    status: order.status,
    openedAt: order.openedAt.toISOString(),
    items: items.map(itemToView),
    subtotal: subtotal.toFixed(2),
    discount: toDiscountView(order),
  };
}

// QA-02 (bugfix) · Traduce las columnas crudas de descuento a la vista pública.
// Las 3 columnas viven juntas (null↔no-null en conjunto, garantizado por
// `applyDiscount`/`removeDiscount`, únicos escritores) — si por algún motivo
// quedaran parcialmente pobladas, se trata como "sin descuento" (fail-safe).
function toDiscountView(order: OrderRow): OrderDiscountView | null {
  if (order.discountType !== 'pct' && order.discountType !== 'amount') {
    return null;
  }
  if (order.discountValue === null || order.discountReason === null) {
    return null;
  }
  return {
    type: order.discountType,
    value: order.discountValue.toFixed(2),
    reason: order.discountReason,
  };
}

/**
 * Resuelve el nombre del mesero (User.name) por su id, dentro de la transacción
 * (tenant-scoped por RLS). null si no hay waiterId o el usuario no existe.
 * Soporta el `waiterName` de los read models del POS (mapa de mesas).
 */
async function resolveWaiterName(
  tx: Tx,
  waiterId: string | null,
): Promise<string | null> {
  if (!waiterId) {
    return null;
  }
  const user = await tx.user.findFirst({
    where: { id: waiterId },
    select: { name: true },
  });
  return user?.name ?? null;
}

@Injectable()
export class OrdersService {
  constructor(private readonly prisma: PrismaService) {}

  /** HU-03-03 · Abrir una mesa libre (crea la orden). Idempotente por idempotencyKey. */
  async open(
    tenantId: string,
    waiterId: string,
    dto: OpenOrderInput,
  ): Promise<OrderView> {
    return this.prisma.runInTenant(tenantId, async (tx) => {
      // Idempotencia: si ya existe una orden con esa clave, devolverla sin duplicar.
      if (dto.idempotencyKey) {
        const existing = await tx.order.findFirst({
          where: { idempotencyKey: dto.idempotencyKey },
        });
        if (existing) {
          return this.buildView(tx, existing);
        }
      }

      const table = await tx.diningTable.findFirst({
        where: { id: dto.tableId, deletedAt: null },
      });
      if (!table) {
        throw new BadRequestException('La mesa no existe');
      }
      if (table.status !== 'free') {
        throw new ConflictException('La mesa no está libre');
      }
      const guests = dto.guests ?? 1;
      if (guests > table.capacity) {
        throw new BadRequestException(
          `La mesa admite hasta ${table.capacity} comensales`,
        );
      }

      let order: OrderRow;
      try {
        order = await tx.order.create({
          data: {
            tenantId,
            tableId: dto.tableId,
            waiterId,
            guests,
            status: 'open',
            idempotencyKey: dto.idempotencyKey ?? null,
          },
        });
      } catch (e) {
        // Carrera con la misma idempotencyKey → devolver la orden existente.
        if (
          dto.idempotencyKey &&
          e instanceof Prisma.PrismaClientKnownRequestError &&
          e.code === 'P2002'
        ) {
          const existing = await tx.order.findFirst({
            where: { idempotencyKey: dto.idempotencyKey },
          });
          if (existing) {
            return this.buildView(tx, existing);
          }
        }
        throw e;
      }

      await tx.diningTable.update({
        where: { id: dto.tableId },
        data: { status: 'occupied' },
      });
      return this.buildView(tx, order);
    });
  }

  async get(tenantId: string, id: string): Promise<OrderView> {
    return this.prisma.runInTenant(tenantId, async (tx) => {
      const order = await this.find(tx, id);
      return this.buildView(tx, order);
    });
  }

  /**
   * Orden "actual" de una mesa (la cuenta abierta): status ∈
   * {open, sent_to_kitchen, served}, no borrada. Devuelve null si la mesa no
   * tiene cuenta activa. Soporta el read-model del POS (GET /api/tables/:id).
   */
  async findCurrentForTable(
    tenantId: string,
    tableId: string,
  ): Promise<OrderView | null> {
    return this.prisma.runInTenant(tenantId, async (tx) => {
      const order = await tx.order.findFirst({
        where: {
          tableId,
          deletedAt: null,
          status: { in: CURRENT_ORDER_STATUSES },
        },
        orderBy: { openedAt: 'desc' },
      });
      return order ? this.buildView(tx, order) : null;
    });
  }

  /**
   * Resumen de la orden actual por mesa (una sola consulta), para enriquecer el
   * listado de mesas sin N+1. Devuelve un Map tableId → resumen.
   */
  async currentSummariesByTable(
    tenantId: string,
  ): Promise<Map<string, TableOrderSummary>> {
    return this.prisma.runInTenant(tenantId, async (tx) => {
      const orders = await tx.order.findMany({
        where: {
          deletedAt: null,
          status: { in: CURRENT_ORDER_STATUSES },
        },
        orderBy: { openedAt: 'desc' },
      });
      // Resolver los nombres de los meseros presentes en UNA consulta (sin N+1).
      const waiterIds = [
        ...new Set(
          orders
            .map((o) => o.waiterId)
            .filter((id): id is string => id !== null),
        ),
      ];
      const waiters =
        waiterIds.length > 0
          ? await tx.user.findMany({
              where: { id: { in: waiterIds } },
              select: { id: true, name: true },
            })
          : [];
      const nameById = new Map(waiters.map((w) => [w.id, w.name]));
      const byTable = new Map<string, TableOrderSummary>();
      for (const order of orders) {
        // orderBy desc → el primero por mesa es el más reciente; no sobrescribir.
        if (byTable.has(order.tableId)) continue;
        byTable.set(order.tableId, {
          currentOrderId: order.id,
          openedAt: order.openedAt.toISOString(),
          guests: order.guests,
          waiterId: order.waiterId,
          waiterName: order.waiterId
            ? (nameById.get(order.waiterId) ?? null)
            : null,
        });
      }
      return byTable;
    });
  }

  /** HU-03-04/05 · Tomar orden: añade ítems con sus modificadores (precio snapshot). */
  async addItems(
    tenantId: string,
    id: string,
    dto: AddOrderItemsInput,
  ): Promise<OrderView> {
    return this.prisma.runInTenant(tenantId, async (tx) => {
      const order = await this.find(tx, id);
      for (const line of dto.items) {
        const menuItem = await tx.menuItem.findFirst({
          where: { id: line.menuItemId, deletedAt: null },
        });
        if (!menuItem) {
          throw new BadRequestException(
            `El plato ${line.menuItemId} no existe`,
          );
        }

        const modifierIds = line.modifierIds ?? [];
        const modifierSnapshots: ModifierSnapshot[] = [];
        let unitPrice = menuItem.price;
        for (const modifierId of modifierIds) {
          const modifier = await tx.menuModifier.findFirst({
            where: {
              id: modifierId,
              menuItemId: menuItem.id,
              deletedAt: null,
            },
          });
          if (!modifier) {
            throw new BadRequestException(
              `El modificador ${modifierId} no pertenece al plato`,
            );
          }
          unitPrice = unitPrice.add(modifier.priceDelta);
          modifierSnapshots.push({
            name: modifier.name,
            priceDelta: Number(modifier.priceDelta.toFixed(2)),
          });
        }

        await tx.orderItem.create({
          data: {
            tenantId,
            orderId: order.id,
            menuItemId: menuItem.id,
            name: menuItem.name,
            qty: line.qty,
            unitPrice,
            notes: line.notes ?? null,
            modifiers: modifierSnapshots as unknown as Prisma.InputJsonValue,
            status: 'pending',
          },
        });
      }
      return this.buildView(tx, order);
    });
  }

  /** HU-03-04/10 · Editar un ítem: cantidad, estado (servido) o quitarlo (soft-delete). */
  async updateItem(
    tenantId: string,
    id: string,
    itemId: string,
    dto: UpdateOrderItemInput,
  ): Promise<OrderView> {
    return this.prisma.runInTenant(tenantId, async (tx) => {
      const order = await this.find(tx, id);
      const item = await tx.orderItem.findFirst({
        where: { id: itemId, orderId: order.id, deletedAt: null },
      });
      if (!item) {
        throw new NotFoundException('Ítem de orden no encontrado');
      }

      if (dto.remove) {
        await tx.orderItem.update({
          where: { id: itemId },
          data: { deletedAt: new Date() },
        });
        return this.buildView(tx, order);
      }

      const data: Prisma.OrderItemUncheckedUpdateInput = {};
      if (dto.qty !== undefined) data.qty = dto.qty;
      if (dto.status !== undefined) {
        data.status = dto.status;
        // HU-03-10: marcar servido sella servedAt (habilita KPIs de tiempo de servicio).
        if (dto.status === 'served') data.servedAt = new Date();
      }
      await tx.orderItem.update({ where: { id: itemId }, data });
      return this.buildView(tx, order);
    });
  }

  /**
   * HU-03-06 · Enviar comanda a cocina. La orden debe estar `open` con ≥1 ítem
   * `pending`. Marca la orden como `sent_to_kitchen` (sentToKitchenAt=now) y, por
   * cada ítem pending sin enviar, sella sentToKitchenAt y enruta a su estación
   * (menuItem → menuCategory → kitchenStationId; puede quedar null).
   */
  async sendToKitchen(tenantId: string, id: string): Promise<OrderView> {
    return this.prisma.runInTenant(tenantId, async (tx) => {
      const order = await this.find(tx, id);
      if (order.status !== 'open') {
        throw new ConflictException(
          'Solo se puede enviar a cocina una orden abierta',
        );
      }
      const pending = await tx.orderItem.findMany({
        where: {
          orderId: order.id,
          deletedAt: null,
          status: 'pending',
          sentToKitchenAt: null,
        },
      });
      if (pending.length === 0) {
        throw new BadRequestException(
          'No hay ítems pendientes por enviar a cocina',
        );
      }

      const now = new Date();
      for (const item of pending) {
        // Estación destino vía la categoría del plato (puede no existir → null).
        const menuItem = await tx.menuItem.findFirst({
          where: { id: item.menuItemId },
          include: { menuCategory: true },
        });
        const kitchenStationId =
          menuItem?.menuCategory?.kitchenStationId ?? null;
        await tx.orderItem.update({
          where: { id: item.id },
          data: { sentToKitchenAt: now, kitchenStationId },
        });
      }

      const updated = await tx.order.update({
        where: { id: order.id },
        data: { status: 'sent_to_kitchen', sentToKitchenAt: now },
      });
      return this.buildView(tx, updated);
    });
  }

  /** HU-03-11 · Anular orden con razón obligatoria; libera la mesa. */
  async void(
    tenantId: string,
    id: string,
    dto: VoidOrderInput,
  ): Promise<OrderView> {
    return this.prisma.runInTenant(tenantId, async (tx) => {
      const order = await this.find(tx, id);
      if (!VOIDABLE_STATUSES.has(order.status)) {
        throw new ConflictException(
          'No se puede anular una orden en este estado',
        );
      }
      const updated = await tx.order.update({
        where: { id: order.id },
        data: { status: 'void', voidReason: dto.reason },
      });
      await tx.diningTable.update({
        where: { id: order.tableId },
        data: { status: 'free' },
      });
      return this.buildView(tx, updated);
    });
  }

  /**
   * QA-02 (bugfix) · Aplica (o reemplaza) el descuento de la cuenta. Root cause
   * del defecto original: el frontend calculaba el descuento SOLO en el modal
   * (preview local) y nunca lo enviaba al backend — el cobro salía por el 100%
   * del importe. Este endpoint persiste la intención de descuento en la orden;
   * `BillingService` es quien lo aplica de verdad a los totales al cobrar
   * (`computeDiscountAmount`), así el ticket y el desglose de IGV quedan
   * consistentes con lo que el mesero/dueño aprobó en el POS.
   *
   * Reglas: la cuenta debe seguir viva (no `paid`/`void` → si no, 409). Para
   * `type='amount'`, el valor NO puede exceder el bruto actual de la orden
   * (Σ unitPrice·qty de los ítems vivos) → 400 si excede (mismo criterio que
   * validó el modal del frontend, pero AHORA como fuente de verdad server-side).
   * `type='pct'` ya viene acotado 0-100 por el DTO (Zod).
   */
  async applyDiscount(
    tenantId: string,
    id: string,
    dto: ApplyDiscountInput,
  ): Promise<OrderView> {
    return this.prisma.runInTenant(tenantId, async (tx) => {
      const order = await this.find(tx, id);
      if (!DISCOUNTABLE_STATUSES.has(order.status)) {
        throw new ConflictException(
          'No se puede aplicar un descuento a una cuenta cerrada (cobrada o anulada)',
        );
      }
      if (dto.type === 'amount') {
        const items = await tx.orderItem.findMany({
          where: { orderId: order.id, deletedAt: null },
        });
        let grossTotal = new Prisma.Decimal(0);
        for (const item of items) {
          grossTotal = grossTotal.add(item.unitPrice.mul(item.qty));
        }
        if (new Prisma.Decimal(dto.value).greaterThan(grossTotal)) {
          throw new BadRequestException(
            'El monto del descuento no puede exceder el total de la cuenta',
          );
        }
      }
      const updated = await tx.order.update({
        where: { id: order.id },
        data: {
          discountType: dto.type,
          discountValue: new Prisma.Decimal(dto.value),
          discountReason: dto.reason,
        },
      });
      return this.buildView(tx, updated);
    });
  }

  /** QA-02 (bugfix) · Quita el descuento vigente (vuelve a cobrar el 100%). */
  async removeDiscount(tenantId: string, id: string): Promise<OrderView> {
    return this.prisma.runInTenant(tenantId, async (tx) => {
      const order = await this.find(tx, id);
      if (!DISCOUNTABLE_STATUSES.has(order.status)) {
        throw new ConflictException(
          'No se puede modificar el descuento de una cuenta cerrada (cobrada o anulada)',
        );
      }
      const updated = await tx.order.update({
        where: { id: order.id },
        data: {
          discountType: null,
          discountValue: null,
          discountReason: null,
        },
      });
      return this.buildView(tx, updated);
    });
  }

  /**
   * QA-02 (bugfix) · Cómputo AUTORITATIVO del descuento en dinero (PEN), dado el
   * bruto de la orden (Σ unitPrice·qty de los ítems vivos al momento de cobrar).
   * Reutilizado por `BillingService` en pre-cuenta/cobro/división — UNA sola
   * fórmula para que los 3 flujos jamás diverjan:
   *  - `pct`:    grossTotal · value/100, redondeado a 2 decimales.
   *  - `amount`: min(value, grossTotal) — nunca deja el total negativo aunque la
   *    orden haya cambiado (ítems removidos) desde que se aplicó el descuento.
   *  - sin descuento (`discountType` null) → 0.
   * Cubre los casos límite del QA: 0% → 0 (cuenta intacta); 100% → grossTotal
   * completo (cuenta gratis, total final S/0.00).
   */
  computeDiscountAmount(
    order: OrderRow,
    grossTotal: Prisma.Decimal,
  ): Prisma.Decimal {
    if (order.discountType === 'pct' && order.discountValue !== null) {
      return grossTotal
        .mul(order.discountValue)
        .div(100)
        .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
    }
    if (order.discountType === 'amount' && order.discountValue !== null) {
      return Prisma.Decimal.min(order.discountValue, grossTotal);
    }
    return new Prisma.Decimal(0);
  }

  /**
   * HU-03-13 · Sugerencias de upsell: platos más vendidos en los últimos 30 días
   * (por suma de qty en order_items) que NO están ya en la orden y están activos.
   * `tenant_id` SIEMPRE del JWT. RLS FORCE garantiza aislamiento. `$queryRaw` para
   * la agregación por popularidad — Prisma ORM no expresa ORDER BY SUM(..) DESC.
   */
  async upsellSuggestions(
    tenantId: string,
    orderId: string,
    limit: number,
  ): Promise<UpsellSuggestionsResponse> {
    return this.prisma.runInTenant(tenantId, async (tx) => {
      // Validate the order exists in the tenant (RLS covers cross-tenant, but a
      // missing order in the same tenant should still return 404 — not 200 + []).
      const order = await tx.order.findFirst({
        where: { id: orderId, deletedAt: null },
        select: { id: true },
      });
      if (!order) {
        throw new NotFoundException('Orden no encontrada');
      }

      // IDs of menu items already in the current order (any status, not deleted).
      const existingItems = await tx.orderItem.findMany({
        where: { orderId, deletedAt: null },
        select: { menuItemId: true },
      });
      const existingIds = existingItems.map((i) => i.menuItemId);

      // Top-selling menu items in the last 30 days, excluding items already in the
      // order and inactive/deleted menu items. Uses $queryRaw for SUM(qty) ranking.
      type RankRow = {
        menu_item_id: string;
        name: string;
        price: string;
        times_sold: string;
      };

      const excludeList =
        existingIds.length > 0
          ? Prisma.sql`AND oi.menu_item_id NOT IN (${Prisma.join(existingIds.map((id) => Prisma.sql`${id}::uuid`))})`
          : Prisma.sql``;

      const rows = await tx.$queryRaw<RankRow[]>(Prisma.sql`
        SELECT oi.menu_item_id::text,
               mi.name,
               mi.price::text,
               SUM(oi.qty)::text AS times_sold
        FROM   order_items oi
        JOIN   menu_items  mi ON mi.id = oi.menu_item_id
        WHERE  oi.created_at >= NOW() - INTERVAL '30 days'
          AND  oi.deleted_at IS NULL
          AND  mi.is_active  = true
          AND  mi.deleted_at IS NULL
          ${excludeList}
        GROUP  BY oi.menu_item_id, mi.name, mi.price
        ORDER  BY SUM(oi.qty) DESC
        LIMIT  ${limit}
      `);

      return rows.map((r) => ({
        menuItemId: r.menu_item_id,
        name: r.name,
        price: new Prisma.Decimal(r.price).toFixed(2),
        timesSold: Number(r.times_sold),
      }));
    });
  }

  private async find(tx: Tx, id: string): Promise<OrderRow> {
    const order = await tx.order.findFirst({
      where: { id, deletedAt: null },
    });
    if (!order) {
      throw new NotFoundException('Orden no encontrada');
    }
    return order;
  }

  /**
   * Construye la vista de una orden dentro de una transacción dada. Público
   * para que otros módulos (E04 billing) reutilicen la vista al cobrar, en la
   * MISMA transacción (consistencia: la orden recién actualizada se ve `paid`).
   */
  async buildView(tx: Tx, order: OrderRow): Promise<OrderView> {
    const items = await tx.orderItem.findMany({
      where: { orderId: order.id, deletedAt: null },
      orderBy: { createdAt: 'asc' },
    });
    const waiterName = await resolveWaiterName(tx, order.waiterId);
    return toView(order, items, waiterName);
  }
}
