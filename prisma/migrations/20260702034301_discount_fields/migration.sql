-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "discount_reason" TEXT,
ADD COLUMN     "discount_type" TEXT,
ADD COLUMN     "discount_value" DECIMAL(12,2);

-- AlterTable
ALTER TABLE "sales" ADD COLUMN     "discount_amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "discount_reason" TEXT,
ADD COLUMN     "discount_type" TEXT,
ADD COLUMN     "discount_value" DECIMAL(12,2);

-- RenameIndex
ALTER INDEX "ingredient_price_history_tenant_id_ingredient_id_recorded_at_id" RENAME TO "ingredient_price_history_tenant_id_ingredient_id_recorded_a_idx";
