import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Audited } from '../audit/audited.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PoliciesGuard } from '../authz/policies.guard';
import { RequireAbility } from '../authz/require-ability.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import {
  addOrderItemsSchema,
  applyDiscountSchema,
  ok,
  openOrderSchema,
  updateOrderItemSchema,
  upsellQuerySchema,
  voidOrderSchema,
  type AddOrderItemsInput,
  type ApiResponse,
  type ApplyDiscountInput,
  type JwtClaims,
  type OpenOrderInput,
  type UpdateOrderItemInput,
  type UpsellQuery,
  type UpsellSuggestionsResponse,
  type VoidOrderInput,
} from '../shared';
import { OrdersService, type OrderView } from './orders.service';

@Controller('orders')
@UseGuards(JwtAuthGuard, PoliciesGuard)
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  // HU-03-03 · Abrir mesa. El mesero (claims.sub) queda como waiterId.
  @Post()
  @RequireAbility('create', 'Order')
  @Audited('order.open')
  async open(
    @CurrentUser() claims: JwtClaims,
    @Body(new ZodValidationPipe(openOrderSchema)) dto: OpenOrderInput,
  ): Promise<ApiResponse<OrderView>> {
    return ok(await this.orders.open(claims.tenant_id, claims.sub, dto));
  }

  @Get(':id')
  @RequireAbility('read', 'Order')
  async get(
    @CurrentUser() claims: JwtClaims,
    @Param('id') id: string,
  ): Promise<ApiResponse<OrderView>> {
    return ok(await this.orders.get(claims.tenant_id, id));
  }

  // HU-03-04/05 · Tomar orden (con modificadores).
  @Post(':id/items')
  @RequireAbility('update', 'Order')
  @Audited('order.add_items')
  async addItems(
    @CurrentUser() claims: JwtClaims,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(addOrderItemsSchema)) dto: AddOrderItemsInput,
  ): Promise<ApiResponse<OrderView>> {
    return ok(await this.orders.addItems(claims.tenant_id, id, dto));
  }

  // HU-03-04/10 · Editar ítem (cantidad / servido / quitar).
  @Patch(':id/items/:itemId')
  @RequireAbility('update', 'Order')
  @Audited('order.update_item')
  async updateItem(
    @CurrentUser() claims: JwtClaims,
    @Param('id') id: string,
    @Param('itemId') itemId: string,
    @Body(new ZodValidationPipe(updateOrderItemSchema))
    dto: UpdateOrderItemInput,
  ): Promise<ApiResponse<OrderView>> {
    return ok(await this.orders.updateItem(claims.tenant_id, id, itemId, dto));
  }

  // HU-03-06 · Enviar comanda a cocina (rutea ítems a sus estaciones).
  @Post(':id/send-to-kitchen')
  @RequireAbility('update', 'Order')
  @Audited('order.send_to_kitchen')
  async sendToKitchen(
    @CurrentUser() claims: JwtClaims,
    @Param('id') id: string,
  ): Promise<ApiResponse<OrderView>> {
    return ok(await this.orders.sendToKitchen(claims.tenant_id, id));
  }

  // HU-03-11 · Anular orden con razón (libera la mesa).
  @Post(':id/void')
  @RequireAbility('update', 'Order')
  @Audited('order.void')
  async void(
    @CurrentUser() claims: JwtClaims,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(voidOrderSchema)) dto: VoidOrderInput,
  ): Promise<ApiResponse<OrderView>> {
    return ok(await this.orders.void(claims.tenant_id, id, dto));
  }

  /**
   * QA-02 (bugfix) · Aplicar descuento a la cuenta. CASL `update Sale` (manager/
   * owner; staff → 403) — MISMO criterio que anular ticket (HU-04-07): un
   * descuento es una decisión financiera, no una operación de mesero/cajero.
   * Coincide con la UI del frontend (badge "Owner" en el modal de descuento).
   */
  @Post(':id/discount')
  @RequireAbility('update', 'Sale')
  @Audited('order.apply_discount')
  async applyDiscount(
    @CurrentUser() claims: JwtClaims,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(applyDiscountSchema)) dto: ApplyDiscountInput,
  ): Promise<ApiResponse<OrderView>> {
    return ok(await this.orders.applyDiscount(claims.tenant_id, id, dto));
  }

  /** QA-02 (bugfix) · Quitar el descuento vigente. Mismo gate que aplicarlo. */
  @Delete(':id/discount')
  @RequireAbility('update', 'Sale')
  @Audited('order.remove_discount')
  async removeDiscount(
    @CurrentUser() claims: JwtClaims,
    @Param('id') id: string,
  ): Promise<ApiResponse<OrderView>> {
    return ok(await this.orders.removeDiscount(claims.tenant_id, id));
  }

  /**
   * HU-03-13 · Sugerencias de upsell: platos populares (últimos 30 días) no
   * presentes en la orden actual. Útil para el mesero durante la toma de pedido.
   * `tenant_id` SIEMPRE del JWT. CASL `read Order`.
   */
  @Get(':id/suggestions')
  @RequireAbility('read', 'Order')
  async suggestions(
    @CurrentUser() claims: JwtClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Query(new ZodValidationPipe(upsellQuerySchema)) query: UpsellQuery,
  ): Promise<ApiResponse<UpsellSuggestionsResponse>> {
    return ok(
      await this.orders.upsellSuggestions(claims.tenant_id, id, query.limit),
    );
  }
}
