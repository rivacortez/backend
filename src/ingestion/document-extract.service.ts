import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PDFParse } from 'pdf-parse';
import * as XLSX from 'xlsx';

// 10 MB file size ceiling — generous for a restaurant menu PDF.
const MAX_FILE_BYTES = 10 * 1024 * 1024;

// Accepted MIME type sets (browser MIME types are unreliable, so we cross-check
// with the filename extension — extension wins on conflict).
const PDF_MIMES = new Set(['application/pdf']);
const XLSX_MIMES = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'application/msexcel',
  'application/x-ms-excel',
]);
const CSV_MIMES = new Set([
  'text/csv',
  'text/plain',
  'application/csv',
  'application/octet-stream', // some browsers send this for unknown text files
]);

/** Supported file format identifiers (mirrored in Zod schema + Pydantic). */
export type SupportedFileType = 'pdf' | 'xlsx' | 'xls' | 'csv' | 'unknown';

export interface FileTextResult {
  text: string;
  type: SupportedFileType;
}

/**
 * E11 Smart Onboarding — file-to-text extraction service.
 *
 * Converts an uploaded file buffer (PDF, Excel, CSV) into a plain-text
 * representation that core-ai can process with the LLM extraction prompt.
 * No DB access; no tenant context required — text extraction is pure I/O.
 *
 * Supported formats:
 *   - PDF    → text layer extracted via pdf-parse (text-based PDFs only).
 *   - xlsx   → SheetJS → CSV per sheet → joined plain text.
 *   - xls    → same SheetJS path (handles both binary and OOXML).
 *   - CSV    → decoded as UTF-8 and passed directly.
 *
 * Scanned/image-only PDFs (no text layer) return an actionable 400 error
 * so the user knows to use Excel/CSV instead.
 */
@Injectable()
export class DocumentExtractService {
  private readonly logger = new Logger(DocumentExtractService.name);

  async extractText(
    buffer: Buffer,
    filename: string,
    mimetype: string,
  ): Promise<FileTextResult> {
    if (buffer.length === 0) {
      throw new BadRequestException('El archivo está vacío');
    }
    if (buffer.length > MAX_FILE_BYTES) {
      const limitMb = MAX_FILE_BYTES / 1024 / 1024;
      throw new BadRequestException(
        `El archivo excede el tamaño máximo de ${limitMb} MB`,
      );
    }

    const type = this.detectType(filename, mimetype);

    switch (type) {
      case 'pdf':
        return { text: await this.fromPdf(buffer), type };
      case 'xlsx':
      case 'xls':
        return { text: this.fromExcel(buffer), type };
      case 'csv':
        return { text: buffer.toString('utf-8'), type };
      default:
        throw new BadRequestException(
          'Tipo de archivo no soportado. Use PDF, Excel (.xlsx / .xls) o CSV.',
        );
    }
  }

  // ---------------------------------------------------------------------------
  // Type detection: filename extension is authoritative; MIME is a fallback.
  // Extension wins because browsers sometimes send wrong MIME types (e.g.
  // 'application/octet-stream' for CSV files on Windows).
  // ---------------------------------------------------------------------------
  private detectType(filename: string, mimetype: string): SupportedFileType {
    const ext = filename.split('.').pop()?.toLowerCase() ?? '';
    if (ext === 'pdf') return 'pdf';
    if (ext === 'xlsx') return 'xlsx';
    if (ext === 'xls') return 'xls';
    if (ext === 'csv') return 'csv';
    // MIME-type fallback for extensionless uploads
    if (PDF_MIMES.has(mimetype)) return 'pdf';
    if (XLSX_MIMES.has(mimetype)) return 'xlsx';
    if (CSV_MIMES.has(mimetype)) return 'csv';
    return 'unknown';
  }

  // ---------------------------------------------------------------------------
  // PDF → text  (pdf-parse v2 class-based API)
  // PDFParse is instantiated with { data: buffer } — the constructor doc notes
  // that Node.js Buffer is converted to Uint8Array automatically.
  // We always call destroy() to release the pdfjs worker resources.
  // ---------------------------------------------------------------------------
  private async fromPdf(buffer: Buffer): Promise<string> {
    const parser = new PDFParse({ data: buffer });
    try {
      const result = await parser.getText();
      const text = result.text?.trim() ?? '';
      if (!text) {
        throw new BadRequestException(
          'El PDF no contiene texto extraíble. ' +
            'Use un PDF con capa de texto, o suba el menú como Excel / CSV.',
        );
      }
      return text;
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      this.logger.warn(
        `PDF extraction failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw new BadRequestException(
        'No se pudo leer el PDF. Verifique que sea un PDF válido con texto seleccionable.',
      );
    } finally {
      await parser.destroy();
    }
  }

  // ---------------------------------------------------------------------------
  // Excel (.xlsx / .xls) → text
  // Converts each sheet to CSV and joins them, preserving sheet names as
  // section headers so the LLM can use them as category hints.
  // ---------------------------------------------------------------------------
  private fromExcel(buffer: Buffer): string {
    let wb: XLSX.WorkBook;
    try {
      wb = XLSX.read(buffer, { type: 'buffer' });
    } catch (err) {
      throw new BadRequestException(
        `No se pudo leer el archivo Excel: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const sections: string[] = [];
    for (const sheetName of wb.SheetNames) {
      const sheet = wb.Sheets[sheetName];
      if (!sheet) continue;
      // sheet_to_csv produces a clean, consistent text representation that is
      // easier for the LLM to parse than raw JSON rows.
      const csv = XLSX.utils.sheet_to_csv(sheet, {
        FS: ',',
        RS: '\n',
        strip: true,
      });
      const trimmed = csv.trim();
      if (trimmed) {
        sections.push(`[Hoja: ${sheetName}]\n${trimmed}`);
      }
    }
    const text = sections.join('\n\n');
    if (!text.trim()) {
      throw new BadRequestException('El archivo Excel está vacío');
    }
    return text;
  }
}
