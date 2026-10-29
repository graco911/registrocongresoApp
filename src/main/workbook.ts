import ExcelJS from 'exceljs';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { AppError, normalize, type Store } from './store';
import { dateSchema, type ImportPreview, type ImportRow } from '../shared/contracts';

function cellText(cell: ExcelJS.Cell): string {
  const value = cell.value;
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') {
    if ('result' in value) {
      if (value.result === undefined) throw new AppError(`Fórmula sin resultado guardado en ${cell.address}.`);
      if (typeof value.result === 'object' && 'error' in value.result) throw new AppError(`Error de Excel en ${cell.address}.`);
      return String(value.result);
    }
    if ('richText' in value) return value.richText.map(part => part.text).join('');
    if ('error' in value) throw new AppError(`Error de Excel en ${cell.address}: ${value.error}`);
    if ('text' in value) return value.text;
  }
  return String(value);
}
export async function previewWorkbook(path: string, store: Store): Promise<ImportPreview & { hash: string }> {
  const bytes = await readFile(path);
  if (bytes.length > 25 * 1024 * 1024) throw new AppError('El Excel supera el límite de 25 MB.');
  const hash = createHash('sha256').update(bytes).digest('hex').toUpperCase();
  if (store.db.prepare('SELECT id FROM import_batches WHERE event_id=1 AND sha256=?').get(hash)) throw new AppError('Este archivo ya fue importado.');
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(new Uint8Array(bytes).buffer);
  if (book.properties.date1904) throw new AppError('El libro usa fechas con base 1904; requiere conversión previa.');
  const sheet = book.getWorksheet('Inscripciones');
  if (!sheet || cellText(sheet.getCell('C7')).trim() !== 'Nombre completo' ||
      !cellText(sheet.getCell('H7')).startsWith('Monto')) throw new AppError('Se requiere la plantilla original: hoja Inscripciones y encabezados en fila 7.');
  const existing = store.list({ query: '', status: '', church: '', attendance: '', sessionId: null });
  const names = new Set(existing.map(p => normalize(p.full_name)));
  const fee = store.snapshot().event.default_fee_cents;
  const rows: ImportRow[] = [];
  for (let rowNumber = 8; rowNumber <= sheet.rowCount; rowNumber++) {
    const r = sheet.getRow(rowNumber);
    const source: Record<string, string> = {};
    for (let col = 1; col <= 14; col++) source[String.fromCharCode(64 + col)] = cellText(r.getCell(col));
    if (!source.C.trim()) {
      if (['B', 'D', 'E', 'F', 'G', 'H', 'K', 'L', 'M', 'N'].some(c => source[c].trim())) throw new AppError(`Fila ${rowNumber}: hay datos sin nombre.`);
      continue;
    }
    const warnings: string[] = [];
    const rawPhone = source.G.trim();
    const digits = rawPhone.replace(/\D/g, '');
    const phone = /^[+\d\s().-]+$/.test(rawPhone) && digits.length >= 7 && digits.length <= 15 ? rawPhone : null;
    if (rawPhone && !phone) warnings.push('El teléfono contiene una nota; se conservó en observaciones.');
    let date: string | null = null;
    const dateCell = r.getCell(2);
    if (dateCell.value instanceof Date) date = dateCell.value.toISOString().slice(0, 10);
    else if (source.B) {
      const serial = Number(source.B);
      if (!Number.isFinite(serial) || serial < 61 || serial > 2958465) throw new AppError(`Fila ${rowNumber}: fecha de Excel inválida.`);
      date = new Date(Date.UTC(1899, 11, 30) + Math.floor(serial) * 86400000).toISOString().slice(0, 10);
    }
    if (date) {
      dateSchema.parse(date);
      if (date > new Date().toISOString().slice(0, 10)) warnings.push('Fecha futura conservada sin corregir.');
    }
    if (!source.H.trim()) warnings.push('Monto vacío: no se creó un pago; confirmar adeudo.');
    const value = source.H.trim() ? Number(source.H) : 0;
    if (!Number.isFinite(value) || value < 0 || Math.abs(value * 100 - Math.round(value * 100)) > 1e-6 || value > 1_000_000) throw new AppError(`Fila ${rowNumber}: importe inválido.`);
    const paid = Math.round(value * 100);
    const status = paid >= fee ? 'Pagado' : paid > 0 ? 'Parcial' : 'Pendiente';
    if (source.J !== status) warnings.push('El estado original difiere del calculado con la tarifa actual.');
    if (source.M.trim() || source.N.trim()) warnings.push('Marca de asistencia original pendiente de revisión; no se generó un ingreso.');
    const duplicate = names.has(normalize(source.C));
    if (duplicate) warnings.push('Posible coincidencia por nombre; excluida inicialmente. Revisa antes de incluir.');
    names.add(normalize(source.C));
    rows.push({
      row: rowNumber, name: source.C.trim(), phone, church: source.D.trim() || null,
      role: source.E.trim() || null, city: source.F.trim() || null, date,
      registeredBy: source.L.trim() || null, paid, method: source.K.trim() || null,
      notes: rawPhone && !phone ? rawPhone : null, source, warnings, duplicate,
    });
  }
  if (!rows.length) throw new AppError('No hay congresistas para importar.');
  return { token: randomUUID(), hash, filename: basename(path), rows };
}

export async function exportWorkbook(path: string, store: Store) {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet('Congresistas');
  sheet.columns = [
    ['folio','Folio',14], ['name','Nombre completo',38], ['phone','Teléfono',20],
    ['email','Correo',30], ['church','Iglesia',30], ['role','Cargo',22],
    ['city','Ciudad',26], ['date','Fecha de inscripción',22], ['by','Inscrito por',22],
    ['fee','Costo',14], ['paid','Pagado',14], ['balance','Saldo',14],
    ['status','Estado',18], ['notes','Observaciones',45],
  ].map(([key, header, width]) => ({ key: String(key), header: String(header), width: Number(width) }));
  const sessions = store.snapshot().sessions;
  const attendance = book.addWorksheet('Asistencia');
  attendance.addRow(['Folio', 'Nombre', 'Sesión', 'Fecha y hora (UTC)', 'Operador', 'Anulado', 'Motivo']);
  const payments = book.addWorksheet('Pagos');
  payments.addRow(['Folio', 'Nombre', 'Tipo', 'Importe', 'Fecha', 'Forma', 'Referencia', 'Operador', 'Anulado', 'Motivo']);
  for (const p of store.list({ query: '', status: '', church: '', attendance: '', sessionId: null })) {
    sheet.addRow({
      folio: p.folio, name: p.full_name, phone: p.phone, email: p.email, church: p.church,
      role: p.role, city: p.city, date: p.registration_date, by: p.registered_by,
      fee: p.fee_cents / 100, paid: p.paid_cents / 100, balance: p.balance_cents / 100,
      status: { paid: 'Liquidado', partial: 'Parcial', pending: 'Pendiente' }[p.payment_status], notes: p.notes,
    });
    const detail = store.detail(p.id);
    for (const payment of detail.payments) payments.addRow([p.folio, p.full_name, payment.kind === 'opening_balance' ? 'Acumulado inicial' : 'Abono', payment.amount_cents / 100, payment.paid_at, payment.method, payment.reference, payment.recorded_by, payment.voided_at, payment.void_reason]);
    for (const checkin of detail.checkins) attendance.addRow([p.folio, p.full_name, sessions.find(s => s.id === checkin.session_id)?.name, checkin.checked_in_at, checkin.recorded_by, checkin.voided_at, checkin.void_reason]);
  }
  for (const s of book.worksheets) {
    s.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    s.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF184C4D' } };
    s.views = [{ state: 'frozen', ySplit: 1 }];
    s.autoFilter = { from: { row: 1, column: 1 }, to: { row: s.rowCount, column: s.columnCount } };
  }
  await book.xlsx.writeFile(path);
}
