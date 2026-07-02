import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { RecipesService } from '../catalog/recipes.service';
import { PrismaService } from '../platform/prisma/prisma.service';
import { OrdersService, type OrderView } from '../pos/orders.service';
import {
  type PayOrderInput,
  type SplitOrderInput,
  type VoidSaleInput,
} from '../shared';
import { limaDayKey, startOfLimaDay } from './lima-day.util';

type Tx = Prisma.TransactionClient;
type SaleRow = Prisma.SaleGetPayload<object>;
type PaymentRow = Prisma.PaymentGetPayload<object>;
type OrderRow = Prisma.OrderGetPayload<object>;
type OrderItemRow = Prisma.OrderItemGetPayload<object>;

// Métodos de pago soportados (orden estable para byMethod del cierre Z).
const PAYMENT_METHODS = ['cash', 'card', 'yape', 'plin'] as const;
type PaymentMethodKey = (typeof PAYMENT_METHODS)[number];

// Series por tipo de comprobante (correlativo por tenant+serie). Boleta = B001,
// factura = F001 (alineado con el frontend: settings.tax.boletaSerie/facturaSerie).
const SERIE_BOLETA = 'B001';
const SERIE_FACTURA = 'F001';

// Estados de orden desde los que se puede cobrar (cuenta viva, no cerrada).
const PAYABLE_ORDER_STATUSES = new Set(['open', 'sent_to_kitchen', 'served']);

// Línea de la pre-cuenta (preview, sin persistir). HU-04-01.
export interface PreBillItem {
  name: string;
  qty: number;
  unitPrice: string;
  lineTotal: string;
}

// QA-02 (bugfix) · Desglose del descuento aplicado (null si la orden no tiene
// uno vigente). `amount` es el monto YA calculado en PEN (autoritativo, no lo
// recalcula el cliente) — evita que el frontend repita la aritmética y diverja.
export interface DiscountBreakdown {
  type: 'pct' | 'amount';
  value: string;
  reason: string;
  amount: string;
}

export interface PreBillView {
  orderId: string;
  tableCode: string;
  items: PreBillItem[];
  // QA-02 (bugfix) · Bruto ANTES de descuento (Σ unitPrice·qty). `subtotal`/
  // `igv`/`total` de abajo ya son POST-descuento — son los que se cobran.
  grossTotal: string;
  discount: DiscountBreakdown | null;
  subtotal: string;
  igv: string;
  total: string;
}

// Ítem del ticket (espejo del SaleItem del frontend).
export interface SaleItemView {
  name: string;
  qty: number;
  unitPrice: string;
  total: string;
}

// Espejo del `Sale` del frontend (moneda como string). `date` = issuedAt ISO.
export interface SaleView {
  id: string;
  orderId: string;
  serie: string;
  number: number;
  docType: string;
  customer: string | null;
  customerDoc: string | null;
  date: string;
  tableLabel: string;
  items: SaleItemView[];
  // QA-02 (bugfix) · Línea de descuento del comprobante (snapshot inmutable al
  // momento del cobro — ver `Sale.discount*` en el schema).
  grossTotal: string;
  discount: DiscountBreakdown | null;
  subtotal: string;
  igv: string;
  total: string;
  method: string;
  payments: { method: string; amount: string }[];
  status: string;
}

// Totales (con IGV incluido en los precios) calculados desde los ítems vivos.
// QA-02 (bugfix) · `grossTotal`/`discountAmount` se agregan para que
// preBill/pay/split compartan LA MISMA aritmética (una sola fuente de verdad).
interface Totals {
  grossTotal: Prisma.Decimal;
  discountAmount: Prisma.Decimal;
  total: Prisma.Decimal;
  subtotal: Prisma.Decimal;
  igv: Prisma.Decimal;
}

// HU-04-03 · Una parte de la cuenta dividida (display; no persiste).
export interface SplitShare {
  label: string;
  subtotal: string;
  igv: string;
  total: string;
}

export interface SplitView {
  orderId: string;
  mode: 'equal' | 'items';
  // QA-02 (bugfix) · Igual que preBill: bruto + descuento vigente, para que el
  // frontend pueda mostrar "cuenta con descuento" al dividir.
  grossTotal: string;
  discount: DiscountBreakdown | null;
  shares: SplitShare[];
  total: string;
}

// QA-07 (bugfix) · Agregado "HOY" (día calendario en America/Lima, UTC-5) de
// comprobantes EMITIDOS. `date` = clave del día Lima usada para el corte, útil
// para que el cliente confirme contra qué ventana está mirando (evita ambigüedad
// cerca de medianoche). Solo cuenta ventas `status='issued'` — igual criterio
// que `totalGross` del cierre Z (las anuladas no suman ingreso).
export interface TodaySalesSummary {
  date: string; // YYYY-MM-DD (Lima)
  total: string;
  count: number;
}

// HU-04-08 · Totales por método de pago (siempre las 4 claves).
export type ByMethod = Record<PaymentMethodKey, string>;

// HU-04-08 · Preview del cierre Z (ventana abierta, no persiste).
export interface CashClosePreview {
  periodStart: string | null;
  salesCount: number;
  voidCount: number;
  totalGross: string;
  byMethod: ByMethod;
  openSince: string | null;
}

// HU-04-08 · Cierre Z persistido (inmutable).
export interface CashCloseView {
  id: string;
  openedAt: string;
  closedAt: string;
  salesCount: number;
  voidCount: number;
  totalGross: string;
  byMethod: ByMethod;
  userId: string | null;
}

// Agregado interno de la ventana abierta (Decimals + cortes de tiempo).
interface WindowAggregate {
  periodStart: Date | null;
  firstIssuedAt: Date | null;
  salesCount: number;
  voidCount: number;
  totalGross: Prisma.Decimal;
  byMethod: Record<PaymentMethodKey, Prisma.Decimal>;
}

@Injectable()
export class BillingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrdersService,
    private readonly recipes: RecipesService,
  ) {}

  /**
   * HU-04-01 · Pre-cuenta (preview, NO persiste). Calcula totales desde los
   * ítems de la orden con el IGV del tenant. La orden no debe estar cerrada.
   */
  async preBill(tenantId: string, orderId: string): Promise<PreBillView> {
    return this.prisma.runInTenant(tenantId, async (tx) => {
      const order = await this.findOrder(tx, orderId);
      if (order.status === 'paid' || order.status === 'void') {
        throw new ConflictException(
          'La orden ya está cerrada (pagada o anulada)',
        );
      }
      const items = await this.liveItems(tx, order.id);
      const igvRate = await this.igvRate(tx, tenantId);
      const totals = this.computeTotals(order, items, igvRate);
      const table = await tx.diningTable.findFirst({
        where: { id: order.tableId },
      });
      return {
        orderId: order.id,
        tableCode: table?.code ?? '',
        items: items.map((it) => ({
          name: it.name,
          qty: it.qty,
          unitPrice: it.unitPrice.toFixed(2),
          lineTotal: it.unitPrice.mul(it.qty).toFixed(2),
        })),
        grossTotal: totals.grossTotal.toFixed(2),
        discount: this.discountBreakdown(order, totals.discountAmount),
        subtotal: totals.subtotal.toFixed(2),
        igv: totals.igv.toFixed(2),
        total: totals.total.toFixed(2),
      };
    });
  }

  /**
   * HU-04-02/04/05/06 · Cobrar: emite el ticket (serie+correlativo + IGV) y
   * registra los pagos en UNA transacción; cierra la orden (paid) y libera la
   * mesa (free). 409 si la orden no es cobrable o ya está pagada; 400 si los
   * pagos no cubren el total.
   */
  async pay(
    tenantId: string,
    orderId: string,
    dto: PayOrderInput,
  ): Promise<{ order: OrderView; sale: SaleView }> {
    return this.prisma.runInTenant(tenantId, async (tx) => {
      const order = await this.findOrder(tx, orderId);
      if (order.status === 'paid') {
        throw new ConflictException('La orden ya fue cobrada');
      }
      if (!PAYABLE_ORDER_STATUSES.has(order.status)) {
        throw new ConflictException(
          'La orden no se puede cobrar en este estado',
        );
      }

      const items = await this.liveItems(tx, order.id);
      const igvRate = await this.igvRate(tx, tenantId);
      const totals = this.computeTotals(order, items, igvRate);

      const paid = dto.payments.reduce(
        (sum, p) => sum.add(new Prisma.Decimal(p.amount)),
        new Prisma.Decimal(0),
      );
      if (paid.lessThan(totals.total)) {
        throw new BadRequestException(
          'Los pagos no cubren el total del ticket',
        );
      }

      const serie = dto.docType === 'factura' ? SERIE_FACTURA : SERIE_BOLETA;
      const number = await this.nextCorrelative(tx, tenantId, serie);

      const sale = await tx.sale.create({
        data: {
          tenantId,
          orderId: order.id,
          serie,
          number,
          docType: dto.docType,
          customer: dto.customer ?? null,
          customerDoc: dto.customerDoc ?? null,
          // QA-02 (bugfix) · Snapshot inmutable del descuento AL MOMENTO DEL
          // COBRO (el ticket ya no debe mutar si la orden cambiara después).
          discountType: order.discountType,
          discountValue: order.discountValue,
          discountReason: order.discountReason,
          discountAmount: totals.discountAmount,
          subtotal: totals.subtotal,
          igv: totals.igv,
          total: totals.total,
          status: 'issued',
        },
      });
      await tx.payment.createMany({
        data: dto.payments.map((p) => ({
          tenantId,
          saleId: sale.id,
          method: p.method,
          amount: new Prisma.Decimal(p.amount),
        })),
      });

      const updatedOrder = await tx.order.update({
        where: { id: order.id },
        data: { status: 'paid' },
      });
      await tx.diningTable.update({
        where: { id: order.tableId },
        data: { status: 'free' },
      });

      // E05 (refinamiento): auto-descuento de stock por la venta, en la MISMA tx.
      await this.consumeStockForSale(tx, tenantId, items, sale.id);

      // Vista de la orden en la MISMA transacción (ya `paid`); reutiliza OrdersService.
      const orderView = await this.orders.buildView(tx, updatedOrder);
      const saleView = await this.buildSaleView(tx, sale);
      return { order: orderView, sale: saleView };
    });
  }

  /**
   * HU-04-03 · Dividir la cuenta por comensal (CÓMPUTO para mostrar, NO persiste;
   * pagar sigue siendo `pay`). `equal`: N partes iguales del total con el resto de
   * redondeo en la primera parte → Σ shares == total. `items`: cada parte agrupa
   * ítems asignados (cada ítem vivo asignado exactamente una vez, si no → 400).
   * 409 si la orden ya está pagada/anulada. "Un ticket por parte" = alcance futuro.
   */
  async split(
    tenantId: string,
    orderId: string,
    dto: SplitOrderInput,
  ): Promise<SplitView> {
    return this.prisma.runInTenant(tenantId, async (tx) => {
      const order = await this.findOrder(tx, orderId);
      if (order.status === 'paid' || order.status === 'void') {
        throw new ConflictException(
          'La orden ya está cerrada (pagada o anulada)',
        );
      }
      const items = await this.liveItems(tx, order.id);
      if (items.length === 0) {
        throw new BadRequestException('La orden no tiene ítems para dividir');
      }
      const igvRate = await this.igvRate(tx, tenantId);
      const totals = this.computeTotals(order, items, igvRate);

      // QA-02 (bugfix) · El descuento tiene que sobrevivir a la división —
      // antes del fix, dividir repartía el BRUTO (Σ unitPrice·qty) ignorando
      // por completo el descuento aplicado en la orden (root cause del "104
      // repartidos" del QA). `equal` ya divide `totals.total` (post-descuento).
      // `items` reparte el descuento PROPORCIONAL al peso bruto de cada parte
      // (ver `splitByItems`) para que Σ shares.total == totals.total siempre.
      const shareTotals =
        dto.mode === 'equal'
          ? this.splitEqual(totals.total, dto.parts ?? order.guests)
          : this.splitByItems(
              items,
              dto.assignments ?? [],
              totals.grossTotal,
              totals.total,
            );

      const shares = shareTotals.map(({ label, total }) =>
        this.shareFromTotal(label, total, igvRate),
      );
      return {
        orderId: order.id,
        mode: dto.mode,
        grossTotal: totals.grossTotal.toFixed(2),
        discount: this.discountBreakdown(order, totals.discountAmount),
        shares,
        total: totals.total.toFixed(2),
      };
    });
  }

  // `equal`: divide `total` en `parts` partes iguales (a 2 decimales) y mete el
  // resto en la PRIMERA parte → Σ partes == total exacto. parts ≥ 2 (default =
  // order.guests, que debe ser ≥ 2; si no, 400).
  private splitEqual(
    total: Prisma.Decimal,
    parts: number,
  ): { label: string; total: Prisma.Decimal }[] {
    if (parts < 2) {
      throw new BadRequestException(
        'Se requieren al menos 2 partes (indique parts ≥ 2 o registre los comensales de la orden)',
      );
    }
    const base = total.div(parts).toDecimalPlaces(2, Prisma.Decimal.ROUND_DOWN);
    const remainder = total.sub(base.mul(parts));
    const result: { label: string; total: Prisma.Decimal }[] = [];
    for (let i = 0; i < parts; i++) {
      const shareTotal = i === 0 ? base.add(remainder) : base;
      result.push({ label: `Parte ${i + 1}`, total: shareTotal });
    }
    return result;
  }

  // `items`: cada parte = Σ (unitPrice·qty) de sus ítems (BRUTO). Valida que
  // CADA ítem vivo de la orden esté asignado exactamente una vez (ni faltante,
  // ni repetido, ni ajeno) → si no, 400.
  //
  // QA-02 (bugfix) · Sin descuento (`grossTotal == orderTotal`, el caso común)
  // el share NETO es idéntico al BRUTO — mismo comportamiento exacto de antes
  // del fix, cero cambio de contrato para las órdenes sin descuento. CON
  // descuento, reparte el descuento proporcional al peso bruto de cada parte
  // (redondeo hacia abajo por parte, resto en la PRIMERA — mismo criterio que
  // `splitEqual`) para garantizar `Σ shares.total === orderTotal` exacto.
  private splitByItems(
    items: OrderItemRow[],
    assignments: { label: string; itemIds: string[] }[],
    grossTotal: Prisma.Decimal,
    orderTotal: Prisma.Decimal,
  ): { label: string; total: Prisma.Decimal }[] {
    const byId = new Map(items.map((it) => [it.id, it]));
    const seen = new Set<string>();
    const grossShares: { label: string; gross: Prisma.Decimal }[] = [];
    for (const assignment of assignments) {
      let gross = new Prisma.Decimal(0);
      for (const itemId of assignment.itemIds) {
        const item = byId.get(itemId);
        if (!item) {
          throw new BadRequestException(
            `El ítem ${itemId} no pertenece a la orden`,
          );
        }
        if (seen.has(itemId)) {
          throw new BadRequestException(
            `El ítem ${itemId} está asignado más de una vez`,
          );
        }
        seen.add(itemId);
        gross = gross.add(item.unitPrice.mul(item.qty));
      }
      grossShares.push({
        label: assignment.label,
        gross: gross.toDecimalPlaces(2),
      });
    }
    if (seen.size !== items.length) {
      throw new BadRequestException(
        'Todos los ítems de la orden deben asignarse exactamente una vez',
      );
    }
    if (grossTotal.equals(orderTotal) || grossTotal.isZero()) {
      return grossShares.map((s) => ({ label: s.label, total: s.gross }));
    }
    const result: { label: string; total: Prisma.Decimal }[] = new Array(
      grossShares.length,
    ) as { label: string; total: Prisma.Decimal }[];
    let allocatedRest = new Prisma.Decimal(0);
    for (let i = 1; i < grossShares.length; i++) {
      const share = grossShares[i];
      if (!share) continue;
      const net = share.gross
        .mul(orderTotal)
        .div(grossTotal)
        .toDecimalPlaces(2, Prisma.Decimal.ROUND_DOWN);
      allocatedRest = allocatedRest.add(net);
      result[i] = { label: share.label, total: net };
    }
    const first = grossShares[0];
    result[0] = {
      label: first ? first.label : '',
      total: orderTotal.sub(allocatedRest),
    };
    return result;
  }

  // Deriva subtotal/igv de una parte a partir de su total (precios incluyen IGV).
  private shareFromTotal(
    label: string,
    total: Prisma.Decimal,
    igvRate: number,
  ): SplitShare {
    const subtotal = total
      .div(new Prisma.Decimal(1).add(igvRate))
      .toDecimalPlaces(2);
    const igv = total.sub(subtotal);
    return {
      label,
      subtotal: subtotal.toFixed(2),
      igv: igv.toFixed(2),
      total: total.toFixed(2),
    };
  }

  /** HU-04-07 · Anular ticket con razón (manager/owner). issued → void. */
  async void(
    tenantId: string,
    saleId: string,
    dto: VoidSaleInput,
  ): Promise<SaleView> {
    return this.prisma.runInTenant(tenantId, async (tx) => {
      const sale = await this.findSale(tx, saleId);
      if (sale.status !== 'issued') {
        throw new ConflictException(
          'El ticket no se puede anular en este estado',
        );
      }
      const updated = await tx.sale.update({
        where: { id: sale.id },
        data: { status: 'void', voidReason: dto.reason },
      });
      return this.buildSaleView(tx, updated);
    });
  }

  async list(tenantId: string): Promise<SaleView[]> {
    return this.prisma.runInTenant(tenantId, async (tx) => {
      const sales = await tx.sale.findMany({ orderBy: { issuedAt: 'desc' } });
      return Promise.all(sales.map((s) => this.buildSaleView(tx, s)));
    });
  }

  async get(tenantId: string, saleId: string): Promise<SaleView> {
    return this.prisma.runInTenant(tenantId, async (tx) => {
      const sale = await this.findSale(tx, saleId);
      return this.buildSaleView(tx, sale);
    });
  }

  /**
   * QA-07 (bugfix) · Agregado "HOY" de comprobantes emitidos. Root cause del
   * defecto original: la card "Hoy" de Comprobantes en el frontend sumaba
   * `GET /api/sales` COMPLETO (ese endpoint es, a propósito, el listado
   * histórico del módulo — sin ventana de fecha, lo necesita la grilla de
   * comprobantes) y lo etiquetaba "Hoy", mezclando el acumulado histórico
   * (S/140,026 del cierre Z anterior) con el turno actual (S/4,862) → el QA vio
   * S/144,888. Este endpoint calcula la ventana del DÍA CALENDARIO en
   * America/Lima (00:00 Lima → ahora) server-side — la única fuente confiable
   * de "hoy" (el cliente no debe derivar zonas horarias de timestamps UTC).
   */
  async todaySummary(tenantId: string): Promise<TodaySalesSummary> {
    return this.prisma.runInTenant(tenantId, async (tx) => {
      const now = new Date();
      const from = startOfLimaDay(now);
      const sales = await tx.sale.findMany({
        where: { status: 'issued', issuedAt: { gte: from, lte: now } },
      });
      let total = new Prisma.Decimal(0);
      for (const sale of sales) {
        total = total.add(sale.total);
      }
      return {
        date: limaDayKey(now),
        total: total.toFixed(2),
        count: sales.length,
      };
    });
  }

  /**
   * HU-04-08 · Preview del cierre Z: agrega las ventas EMITIDAS desde el último
   * cierre (o all-time si no hay), sin persistir. Devuelve totales + por método
   * + conteos de la ventana abierta.
   */
  async cashClosePreview(tenantId: string): Promise<CashClosePreview> {
    return this.prisma.runInTenant(tenantId, (tx) =>
      this.aggregateOpenWindow(tx).then((agg) => this.toPreview(agg)),
    );
  }

  /**
   * HU-04-08 · Cierre Z (cierre del turno): persiste el agregado de la ventana
   * abierta como una fila INMUTABLE de cash_closes. openedAt = closedAt del último
   * cierre, o issuedAt de la primera venta, o now si no hay ventas. closedAt = now.
   * Tras cerrar, el siguiente preview arranca una ventana fresca.
   */
  async cashClose(tenantId: string, userId: string): Promise<CashCloseView> {
    return this.prisma.runInTenant(tenantId, async (tx) => {
      const agg = await this.aggregateOpenWindow(tx);
      const now = new Date();
      const openedAt = agg.periodStart ?? agg.firstIssuedAt ?? now;
      const created = await tx.cashClose.create({
        data: {
          tenantId,
          openedAt,
          closedAt: now,
          salesCount: agg.salesCount,
          voidCount: agg.voidCount,
          totalGross: agg.totalGross,
          byMethod: this.byMethodToStrings(
            agg.byMethod,
          ) as unknown as Prisma.InputJsonValue,
          userId,
        },
      });
      return this.toCashCloseView(created);
    });
  }

  /** HU-04-08 · Lista los cierres Z pasados (desc por closedAt). */
  async listCashCloses(tenantId: string): Promise<CashCloseView[]> {
    return this.prisma.runInTenant(tenantId, async (tx) => {
      const closes = await tx.cashClose.findMany({
        orderBy: { closedAt: 'desc' },
      });
      return closes.map((c) => this.toCashCloseView(c));
    });
  }

  // --- helpers ---

  private async findOrder(tx: Tx, id: string): Promise<OrderRow> {
    const order = await tx.order.findFirst({ where: { id, deletedAt: null } });
    if (!order) {
      throw new NotFoundException('Orden no encontrada');
    }
    return order;
  }

  private async findSale(tx: Tx, id: string): Promise<SaleRow> {
    const sale = await tx.sale.findFirst({ where: { id } });
    if (!sale) {
      throw new NotFoundException('Ticket no encontrado');
    }
    return sale;
  }

  private liveItems(tx: Tx, orderId: string): Promise<OrderItemRow[]> {
    return tx.orderItem.findMany({
      where: { orderId, deletedAt: null },
      orderBy: { createdAt: 'asc' },
    });
  }

  private async igvRate(tx: Tx, tenantId: string): Promise<number> {
    const tenant = await tx.tenant.findUniqueOrThrow({
      where: { id: tenantId },
    });
    return tenant.igvRate;
  }

  // Precios INCLUYEN IGV. QA-02 (bugfix) · Único punto de cálculo de totales
  // usado por preBill/pay/split — antes del fix, el descuento se calculaba SOLO
  // en el frontend (preview local) y nunca llegaba a esta función, así que el
  // cobro salía por el bruto completo. Ahora:
  //   grossTotal = Σ unitPrice·qty (bruto, antes de descuento);
  //   discountAmount = OrdersService.computeDiscountAmount(order, grossTotal)
  //     (0 si la orden no tiene descuento vigente — órdenes intactas, sin cambio);
  //   total = grossTotal − discountAmount (base imponible + IGV YA con el
  //     descuento aplicado — esto es lo que se cobra y lo que ve el ticket);
  //   subtotal = total/(1+igvRate); igv = total − subtotal (IGV 18% sobre la
  //     base YA descontada, no sobre el bruto — la corrección central del defecto).
  // Redondeo a 2 decimales (PEN) en cada paso.
  private computeTotals(
    order: OrderRow,
    items: OrderItemRow[],
    igvRate: number,
  ): Totals {
    let grossTotal = new Prisma.Decimal(0);
    for (const item of items) {
      grossTotal = grossTotal.add(item.unitPrice.mul(item.qty));
    }
    grossTotal = grossTotal.toDecimalPlaces(2);
    const discountAmount = this.orders.computeDiscountAmount(order, grossTotal);
    const total = grossTotal.sub(discountAmount).toDecimalPlaces(2);
    const subtotal = total
      .div(new Prisma.Decimal(1).add(igvRate))
      .toDecimalPlaces(2);
    const igv = total.sub(subtotal);
    return { grossTotal, discountAmount, total, subtotal, igv };
  }

  // QA-02 (bugfix) · Traduce las columnas de descuento (de una Order o de un
  // Sale ya emitido — ambas comparten los mismos 3 nombres de campo) a la
  // vista pública, con el monto ya calculado. null = sin descuento vigente.
  private discountBreakdown(
    source: {
      discountType: string | null;
      discountValue: Prisma.Decimal | null;
      discountReason: string | null;
    },
    discountAmount: Prisma.Decimal,
  ): DiscountBreakdown | null {
    if (source.discountType !== 'pct' && source.discountType !== 'amount') {
      return null;
    }
    if (source.discountValue === null || source.discountReason === null) {
      return null;
    }
    return {
      type: source.discountType,
      value: source.discountValue.toFixed(2),
      reason: source.discountReason,
      amount: discountAmount.toFixed(2),
    };
  }

  // Correlativo: (max number para tenant+serie) + 1; arranca en 1.
  private async nextCorrelative(
    tx: Tx,
    tenantId: string,
    serie: string,
  ): Promise<number> {
    const last = await tx.sale.findFirst({
      where: { tenantId, serie },
      orderBy: { number: 'desc' },
    });
    return (last?.number ?? 0) + 1;
  }

  private async buildSaleView(tx: Tx, sale: SaleRow): Promise<SaleView> {
    const payments = await tx.payment.findMany({
      where: { saleId: sale.id },
      orderBy: { createdAt: 'asc' },
    });
    const items = await this.liveItems(tx, sale.orderId);
    const order = await tx.order.findFirst({ where: { id: sale.orderId } });
    const table = order
      ? await tx.diningTable.findFirst({ where: { id: order.tableId } })
      : null;
    return {
      id: sale.id,
      orderId: sale.orderId,
      serie: sale.serie,
      number: sale.number,
      docType: sale.docType,
      customer: sale.customer,
      customerDoc: sale.customerDoc,
      date: sale.issuedAt.toISOString(),
      tableLabel: table ? `Mesa ${table.code}` : '',
      items: items.map((it) => ({
        name: it.name,
        qty: it.qty,
        unitPrice: it.unitPrice.toFixed(2),
        total: it.unitPrice.mul(it.qty).toFixed(2),
      })),
      // QA-02 (bugfix) · Del SNAPSHOT persistido en el Sale (inmutable — no se
      // recalcula desde la orden, que pudo cambiar después de cobrar).
      grossTotal: sale.total.add(sale.discountAmount).toFixed(2),
      discount: this.discountBreakdown(sale, sale.discountAmount),
      subtotal: sale.subtotal.toFixed(2),
      igv: sale.igv.toFixed(2),
      total: sale.total.toFixed(2),
      method: this.firstMethod(payments),
      payments: payments.map((p) => ({
        method: p.method,
        amount: p.amount.toFixed(2),
      })),
      status: sale.status,
    };
  }

  private firstMethod(payments: PaymentRow[]): string {
    return payments[0]?.method ?? 'cash';
  }

  /**
   * E05 (refinamiento POS↔inventario) · Auto-descuento de stock al vender. Por
   * cada `order_item` vivo, resuelve su receta (menuItem → recipeId) y explota el
   * BOM a cantidades de insumo: consumo de una unidad vendida = `explode(recipe,
   * 1/recipe.yield)`, multiplicado por `order_item.qty`. Acumula por insumo (UN
   * movimiento por insumo, no por ítem) y, dentro de la MISMA transacción del
   * cobro, crea un `inventory_movements` `type='sale'` con `qty` negativo
   * (`note='Venta <saleId>'`, `userId=null`) y descuenta `ingredient.stock`.
   *
   * POLÍTICA DE STOCK NEGATIVO: una venta NUNCA se bloquea por falta de stock —
   * el cobro ya ocurrió y es la fuente de verdad. Se permite que el stock quede
   * NEGATIVO (≠ la salida manual HU-05-03, que rechaza negativo); corregirlo es
   * trabajo de inventario (recepción/ajuste/conteo), no del cajero.
   */
  private async consumeStockForSale(
    tx: Tx,
    tenantId: string,
    items: OrderItemRow[],
    saleId: string,
  ): Promise<void> {
    // Acumula la cantidad consumida por insumo en toda la orden.
    const consumed = new Map<string, Prisma.Decimal>();
    for (const item of items) {
      const menuItem = await tx.menuItem.findFirst({
        where: { id: item.menuItemId },
        select: { recipeId: true },
      });
      if (!menuItem) {
        continue; // plato sin receta resoluble → no consume (no rompe el cobro)
      }
      const recipe = await tx.recipe.findFirst({
        where: { id: menuItem.recipeId, deletedAt: null },
        select: { yield: true },
      });
      if (!recipe || recipe.yield.isZero()) {
        continue;
      }
      // Consumo de una unidad vendida = explosión del BOM por 1/yield; el ítem
      // consume eso · qty (el qty es entero, número de platos del ítem).
      const perUnit = new Prisma.Decimal(1).div(recipe.yield);
      const multiplier = perUnit.mul(item.qty);
      const exploded = await this.recipes.explodeIngredientsTx(
        tx,
        menuItem.recipeId,
        multiplier,
      );
      for (const [ingredientId, qty] of exploded) {
        const prev = consumed.get(ingredientId) ?? new Prisma.Decimal(0);
        consumed.set(ingredientId, prev.add(qty));
      }
    }

    // Un movimiento `sale` (qty negativo) por insumo + descuento de stock.
    for (const [ingredientId, qty] of consumed) {
      if (qty.isZero()) {
        continue;
      }
      const ingredient = await tx.ingredient.findFirst({
        where: { id: ingredientId },
        select: { stock: true },
      });
      if (!ingredient) {
        continue;
      }
      await tx.inventoryMovement.create({
        data: {
          tenantId,
          ingredientId,
          type: 'sale',
          qty: qty.negated(),
          note: `Venta ${saleId}`,
          userId: null,
        },
      });
      // Stock puede quedar negativo a propósito (la venta no se bloquea).
      await tx.ingredient.update({
        where: { id: ingredientId },
        data: { stock: ingredient.stock.sub(qty) },
      });
    }
  }

  // --- HU-04-08 · agregación del cierre Z ---

  // Agrega la ventana abierta: desde el closedAt del último cierre (o all-time si
  // no hay). Cuenta ventas issued vs void en la ventana, suma `total` de las
  // issued (totalGross) y suma `payment.amount` por método (solo de las issued).
  private async aggregateOpenWindow(tx: Tx): Promise<WindowAggregate> {
    const lastClose = await tx.cashClose.findFirst({
      orderBy: { closedAt: 'desc' },
    });
    const periodStart = lastClose?.closedAt ?? null;
    const issuedAtFilter = periodStart ? { gt: periodStart } : undefined;

    const sales = await tx.sale.findMany({
      where: issuedAtFilter ? { issuedAt: issuedAtFilter } : {},
      orderBy: { issuedAt: 'asc' },
      include: { payments: true },
    });

    const byMethod = this.emptyByMethod();
    let totalGross = new Prisma.Decimal(0);
    let salesCount = 0;
    let voidCount = 0;
    let firstIssuedAt: Date | null = null;
    for (const sale of sales) {
      if (firstIssuedAt === null) firstIssuedAt = sale.issuedAt;
      if (sale.status === 'void') {
        voidCount += 1;
        continue;
      }
      salesCount += 1;
      totalGross = totalGross.add(sale.total);
      for (const payment of sale.payments) {
        if (this.isPaymentMethod(payment.method)) {
          byMethod[payment.method] = byMethod[payment.method].add(
            payment.amount,
          );
        }
      }
    }

    return {
      periodStart,
      firstIssuedAt,
      salesCount,
      voidCount,
      totalGross,
      byMethod,
    };
  }

  private toPreview(agg: WindowAggregate): CashClosePreview {
    return {
      periodStart: agg.periodStart ? agg.periodStart.toISOString() : null,
      salesCount: agg.salesCount,
      voidCount: agg.voidCount,
      totalGross: agg.totalGross.toFixed(2),
      byMethod: this.byMethodToStrings(agg.byMethod),
      openSince: (agg.periodStart ?? agg.firstIssuedAt)?.toISOString() ?? null,
    };
  }

  private toCashCloseView(
    row: Prisma.CashCloseGetPayload<object>,
  ): CashCloseView {
    return {
      id: row.id,
      openedAt: row.openedAt.toISOString(),
      closedAt: row.closedAt.toISOString(),
      salesCount: row.salesCount,
      voidCount: row.voidCount,
      totalGross: row.totalGross.toFixed(2),
      byMethod: this.normalizeByMethod(row.byMethod),
      userId: row.userId,
    };
  }

  private emptyByMethod(): Record<PaymentMethodKey, Prisma.Decimal> {
    return {
      cash: new Prisma.Decimal(0),
      card: new Prisma.Decimal(0),
      yape: new Prisma.Decimal(0),
      plin: new Prisma.Decimal(0),
    };
  }

  private byMethodToStrings(
    byMethod: Record<PaymentMethodKey, Prisma.Decimal>,
  ): ByMethod {
    return {
      cash: byMethod.cash.toFixed(2),
      card: byMethod.card.toFixed(2),
      yape: byMethod.yape.toFixed(2),
      plin: byMethod.plin.toFixed(2),
    };
  }

  // Lee el JSON persistido (Prisma.JsonValue) y lo normaliza a ByMethod string.
  private normalizeByMethod(value: Prisma.JsonValue): ByMethod {
    const obj =
      typeof value === 'object' && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
    const read = (key: PaymentMethodKey): string => {
      const raw = obj[key];
      return typeof raw === 'string' ? raw : '0.00';
    };
    return {
      cash: read('cash'),
      card: read('card'),
      yape: read('yape'),
      plin: read('plin'),
    };
  }

  private isPaymentMethod(method: string): method is PaymentMethodKey {
    return (PAYMENT_METHODS as readonly string[]).includes(method);
  }
}
