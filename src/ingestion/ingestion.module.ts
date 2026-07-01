import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AuthzModule } from '../authz/authz.module';
import { PlatformModule } from '../platform/platform.module';
import { CoreAiExtractClient } from './core-ai-extract.client';
import { DocumentCommitService } from './document-commit.service';
import { DocumentExtractService } from './document-extract.service';
import { DocumentImportController } from './document-import.controller';
import { SalesHistoryController } from './sales-history.controller';
import { SalesHistoryImportService } from './sales-history-import.service';
import { SalesHistoryService } from './sales-history.service';

/**
 * E11 — Migración e incorporación de datos legacy y Smart Onboarding.
 *
 * Incrementos construidos:
 *   - Histórico de ventas por CSV (HU-11-03/04/05): `SalesHistoryController`.
 *   - Smart Onboarding (HU-11-06/07/08): `DocumentImportController` —
 *     carga un PDF/Excel/CSV del menú o insumos, extrae con IA (core-ai)
 *     y crea el catálogo inicial del tenant (preview → commit idempotente).
 *
 * El wizard de carga R2 (HU-11-01) queda diferido.
 * Importación CSV de productos (HU-11-02) = HU-02-02 (catálogo, hecho).
 */
@Module({
  imports: [PlatformModule, AuthModule, AuthzModule],
  controllers: [SalesHistoryController, DocumentImportController],
  providers: [
    SalesHistoryImportService,
    SalesHistoryService,
    DocumentExtractService,
    CoreAiExtractClient,
    DocumentCommitService,
  ],
})
export class IngestionModule {}
