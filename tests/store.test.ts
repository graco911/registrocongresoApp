import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, copyFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { backup } from 'node:sqlite';
import ExcelJS from 'exceljs';
import { Store } from '../src/main/store';
import { exportWorkbook, previewWorkbook } from '../src/main/workbook';
import { maskPhone, normalizePhone, cleanEmail, isMexicanPhone } from '../src/shared/contact';

const schema = resolve('database/schema.sql');
const input = {
  full_name: 'María José Pérez', phone: '9931234567', email: 'maria@example.test',
  church: 'Sinaí', role: 'Anciano', city: 'Comalcalco', registration_date: '2026-10-28',
  notes: '', fee_cents: 20000,
};
const filters = { query: '', status: '', church: '', attendance: '', sessionId: null };
function fixture(seed = false) {
  const folder = mkdtempSync(join(tmpdir(), 'congreso-store-'));
  const path = join(folder, 'congreso.sqlite');
  if (seed) {
    if (!existsSync('data/congreso.sqlite')) throw new Error('Falta la base inicial para verificar la migración.');
    copyFileSync('data/congreso.sqlite', path);
  }
  const store = new Store(path, schema);
  return { store, folder, path, cleanup: () => { store.close(); rmSync(folder, { recursive: true }); } };
}
function admin(store: Store) { return store.setup({ username: 'admin', password: 'testing-password' }); }

test('migra la base inicial sin alterar personas, pagos ni procedencia', () => {
  const f = fixture(true);
  try {
    assert.equal(f.store.needsSetup(), true);
    admin(f.store);
    const snapshot = f.store.snapshot();
    assert.equal(snapshot.sessions.length, 2);
    assert.deepEqual(snapshot.stats, { count: 51, paid: 900000, balance: 120000, issues: 20 });
    const people = f.store.list(filters);
    assert.equal(people.filter(p => p.payment_status === 'paid').length, 43);
    const first = f.store.detail(1);
    assert.equal(first.source?.G, 'PARA EL DIA 13');
    assert.equal(first.person.phone, null);
    assert.equal(first.checkins.length, 0);
    assert.equal(f.store.db.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
  } finally { f.cleanup(); }
});

test('registro, búsqueda sin acentos, validación y auditoría', () => {
  const f = fixture();
  try {
    assert.throws(() => f.store.list(filters), /permiso/);
    admin(f.store);
    const id = f.store.savePerson(input);
    assert.equal(f.store.list({ ...filters, query: 'maria perez' }).length, 1);
    assert.equal(f.store.list({ ...filters, query: '993123' }).length, 1);
    f.store.savePerson({ ...input, id, phone: '', email: '', notes: "O'Brien" });
    assert.equal(f.store.detail(id).person.notes, "O'Brien");
    assert.equal(f.store.detail(id).person.email, null);
    assert.throws(() => f.store.savePerson({ ...input, registration_date: '2026-02-31' }));
    assert.throws(() => f.store.savePerson({ ...input, fee_cents: -1 }));
    assert.throws(() => f.store.savePerson({ ...input, email: 'incorrecto' }));
    assert.throws(() => f.store.savePerson({ ...input, phone: 'PARA EL DIA 13' }));
    assert.equal(f.store.snapshot().stats.count, 1);
    assert.equal(f.store.db.prepare("SELECT count(*) n FROM audit_log WHERE action='update_registration'").get()!.n, 1);
  } finally { f.cleanup(); }
});

test('máscara mexicana y correo: normalización, opcionales y validación al guardar', () => {
  const f = fixture();
  try {
    admin(f.store);
    for (const [raw, masked, saved] of [
      ['9931234567', '(993) 123-4567', '9931234567'],
      ['+529931234567', '+52 (993) 123-4567', '+529931234567'],
      ['529931234567', '+52 (993) 123-4567', '+529931234567'],
      ['(993) 123-4567', '(993) 123-4567', '9931234567'],
    ]) {
      assert.equal(maskPhone(raw), masked);
      assert.equal(maskPhone(masked), masked);
      assert.equal(normalizePhone(masked), saved);
      assert.equal(isMexicanPhone(raw), true);
      const id = f.store.savePerson({ ...input, phone: raw, email: ' Maria.Perez+congreso @ example.test ' });
      assert.equal(f.store.detail(id).person.phone, saved);
      assert.equal(f.store.detail(id).person.email, 'Maria.Perez+congreso@example.test');
      assert.equal(f.store.list({ ...filters, query: '9931234567' }).some(p => p.id === id), true);
    }
    assert.equal(maskPhone(''), '');
    assert.equal(maskPhone('9'), '(9');
    assert.equal(maskPhone('993'), '(993)');
    assert.equal(maskPhone('+5'), '+5');
    assert.equal(maskPhone('+52'), '+52');
    assert.equal(maskPhone('99312345678'), '99312345678');
    assert.equal(cleanEmail(' maria @ example.test '), 'maria@example.test');
    for (const phone of ['993123456', '99312345678', '+19931234567', '+52', 'texto', '(993) 123-4567 ext 2']) {
      assert.throws(() => f.store.savePerson({ ...input, phone }), /10 dígitos/);
    }
    for (const email of ['maria', 'maria@', 'maria@@example.test', 'maria@example']) {
      assert.throws(() => f.store.savePerson({ ...input, email }), /Correo inválido/);
    }
    const id = f.store.savePerson({ ...input, phone: '', email: '   ' });
    assert.equal(f.store.detail(id).person.phone, null);
    assert.equal(f.store.detail(id).person.email, null);
  } finally { f.cleanup(); }
});

test('abonos, excedentes, anulaciones y tarifa individual', () => {
  const f = fixture();
  try {
    admin(f.store);
    const id = f.store.savePerson(input);
    const pay = { registrationId: id, amount_cents: 10000, paid_at: '2026-10-28', method: 'Efectivo', reference: '', notes: '' };
    f.store.addPayment(pay);
    assert.equal(f.store.detail(id).person.payment_status, 'partial');
    f.store.addPayment({ ...pay, amount_cents: 15000 });
    assert.equal(f.store.detail(id).person.excess_cents, 5000);
    const payment = f.store.detail(id).payments[0];
    assert.throws(() => f.store.voidPayment({ id: payment.id, reason: '' }));
    f.store.voidPayment({ id: payment.id, reason: 'Captura errónea' });
    assert.equal(f.store.detail(id).person.balance_cents, 10000);
    assert.throws(() => f.store.voidPayment({ id: payment.id, reason: 'Otra anulación' }), /anulado/);
    assert.throws(() => f.store.addPayment({ ...pay, registrationId: 9999 }));
    assert.throws(() => f.store.addPayment({ ...pay, amount_cents: 0 }));
    f.store.saveSettings({ name: 'Congreso', default_fee_cents: 30000, allow_debt: true, sessions: [{ id: 1, name: 'Viernes 13', session_date: '' }] });
    assert.equal(f.store.detail(id).person.fee_cents, 20000);
    assert.equal(f.store.db.prepare('PRAGMA foreign_key_check').all().length, 0);
  } finally { f.cleanup(); }
});

test('check-in por sesión, fecha obligatoria, adeudo, duplicados y corrección', () => {
  const f = fixture();
  try {
    admin(f.store);
    const id = f.store.savePerson(input);
    assert.throws(() => f.store.checkin({ registrationId: id, sessionId: 1 }), /fecha/);
    const settings = { name: 'Congreso', default_fee_cents: 20000, allow_debt: false, sessions: [{ id: 1, name: 'Viernes 13', session_date: '2026-11-13' }, { id: 2, name: 'Sábado 14', session_date: '2026-11-14' }] };
    f.store.saveSettings(settings);
    assert.throws(() => f.store.checkin({ registrationId: id, sessionId: 1 }), /adeudo/);
    f.store.saveSettings({ ...settings, allow_debt: true });
    assert.equal(f.store.checkin({ registrationId: id, sessionId: 1 }).existing, false);
    assert.equal(f.store.checkin({ registrationId: id, sessionId: 1 }).existing, true);
    assert.equal(f.store.checkin({ registrationId: id, sessionId: 2 }).existing, false);
    assert.equal(f.store.list({ ...filters, sessionId: 1, attendance: 'yes' }).length, 1);
    f.store.voidCheckin({ id: f.store.detail(id).checkins[1].id, reason: 'Sesión incorrecta' });
    assert.equal(f.store.checkin({ registrationId: id, sessionId: 1 }).existing, false);
    assert.throws(() => f.store.checkin({ registrationId: id, sessionId: 9999 }), /válida/);
  } finally { f.cleanup(); }
});

test('sesiones: agregar, editar, intercambiar nombres y quitar conservando al menos una', () => {
  const f = fixture();
  try {
    admin(f.store);
    const settings = { name: 'Congreso', default_fee_cents: 20000, allow_debt: true };
    const save = (sessions: { id?: number; name: string; session_date: string }[]) => f.store.saveSettings({ ...settings, sessions });
    const initial = f.store.snapshot().sessions.map(s => ({ ...s, session_date: '' }));
    save([{ ...initial[0], name: initial[1].name }, { ...initial[1], name: initial[0].name }]);
    assert.equal(f.store.snapshot().sessions[0].name, initial[1].name);
    save([{ ...initial[0], name: 'Apertura', session_date: '2026-11-13' }]);
    assert.equal(f.store.snapshot().sessions.length, 1);
    assert.throws(() => save([]), /al menos una sesión/);
    assert.equal(f.store.snapshot().sessions.length, 1);
    save([{ ...initial[0], name: 'Apertura', session_date: '2026-11-13' }, { name: 'Clausura', session_date: '2026-11-14' }]);
    assert.equal(f.store.snapshot().sessions.length, 2);
    const before = f.store.snapshot();
    assert.throws(() => save([{ ...initial[0], name: 'Uno' }, { ...initial[0], name: 'Dos' }]), /más de una vez/);
    assert.throws(() => save([{ id: 9999, name: 'Ajena', session_date: '' }]), /inexistente/);
    assert.throws(() => save([{ name: 'Sinaí', session_date: '' }, { name: 'SINAI', session_date: '' }]), /repetirse/);
    assert.deepEqual(f.store.snapshot(), before);
    assert.equal(f.store.db.prepare("SELECT count(*) n FROM audit_log WHERE action='delete_session'").get()!.n, 1);
  } finally { f.cleanup(); }
});

test('no elimina sesiones con ingresos vigentes o anulados y revierte todos los cambios', () => {
  const f = fixture();
  try {
    admin(f.store);
    const id = f.store.savePerson(input);
    const settings = {
      name: 'Congreso', default_fee_cents: 20000, allow_debt: true,
      sessions: [{ id: 1, name: 'Apertura', session_date: '2026-11-13' }, { id: 2, name: 'Clausura', session_date: '2026-11-14' }],
    };
    f.store.saveSettings(settings);
    f.store.checkin({ registrationId: id, sessionId: 1 });
    const before = f.store.snapshot();
    const removeUsed = () => f.store.saveSettings({ ...settings, name: 'No debe persistir', sessions: [settings.sessions[1]] });
    assert.throws(removeUsed, /tiene ingresos/);
    assert.deepEqual(f.store.snapshot(), before);
    f.store.voidCheckin({ id: f.store.detail(id).checkins[0].id, reason: 'Prueba' });
    assert.throws(removeUsed, /incluso si fueron anulados/);
    assert.deepEqual(f.store.snapshot(), before);
    assert.equal(f.store.detail(id).checkins.length, 1);
    assert.equal(f.store.db.prepare('PRAGMA foreign_key_check').all().length, 0);
  } finally { f.cleanup(); }
});

test('roles, contraseñas y desactivación', () => {
  const f = fixture();
  try {
    const owner = admin(f.store);
    const id = f.store.savePerson(input);
    f.store.addOperator({ username: 'caja', password: 'password-caja', role: 'cashier' });
    f.store.addOperator({ username: 'entrada', password: 'password-entrada', role: 'reception' });
    f.store.user = null;
    assert.throws(() => f.store.login({ username: 'admin', password: 'incorrecto' }), /incorrectos/);
    f.store.login({ username: 'caja', password: 'password-caja' });
    assert.throws(() => f.store.saveSettings({}), /permiso/);
    assert.throws(() => f.store.savePerson({ ...input, id, fee_cents: 10000 }), /administración/);
    f.store.savePerson({ ...input, id, city: 'Otra ciudad' });
    f.store.login({ username: 'entrada', password: 'password-entrada' });
    assert.equal(f.store.detail(id).person.city, 'Otra ciudad');
    assert.throws(() => f.store.savePerson(input), /permiso/);
    assert.throws(() => f.store.addPayment({}), /permiso/);
    assert.throws(() => f.store.operators(), /permiso/);
    f.store.login({ username: 'admin', password: 'testing-password' });
    const reception = f.store.operators().find(o => o.username === 'entrada')!;
    f.store.disableOperator(reception.id);
    assert.throws(() => f.store.disableOperator(owner.id), /propia cuenta/);
    assert.throws(() => f.store.login({ username: 'entrada', password: 'password-entrada' }), /incorrectos/);
    assert.throws(() => f.store.setup({ username: 'otro', password: 'password-otro' }), /creado/);
  } finally { f.cleanup(); }
});

test('importación real con vista previa, notas, coincidencias y repetición', async () => {
  const f = fixture();
  try {
    admin(f.store);
    const preview = await previewWorkbook(resolve('Libro7.xlsx'), f.store);
    assert.equal(preview.rows.length, 51);
    assert.equal(preview.rows.reduce((sum, p) => sum + p.paid, 0), 900000);
    assert.equal(preview.rows[0].phone, null);
    assert.equal(preview.rows[0].notes, 'PARA EL DIA 13');
    assert.equal(f.store.importRows(preview.filename, preview.hash, preview.rows), 51);
    assert.equal(f.store.snapshot().stats.paid, 900000);
    await assert.rejects(() => previewWorkbook(resolve('Libro7.xlsx'), f.store), /ya fue importado/);
    assert.throws(() => f.store.importRows(preview.filename, preview.hash, preview.rows), /ya fue importado/);
    const exported = join(f.folder, 'reporte.xlsx');
    await exportWorkbook(exported, f.store);
    const book = new ExcelJS.Workbook();
    await book.xlsx.readFile(exported);
    assert.equal(book.getWorksheet('Congresistas')!.rowCount, 52);
    assert.equal(book.getWorksheet('Pagos')!.rowCount, 48);
    assert.equal(book.getWorksheet('Asistencia')!.rowCount, 1);
  } finally { f.cleanup(); }
});

test('rollback de importación inválida y respaldo restaurable', async () => {
  const f = fixture();
  try {
    admin(f.store);
    const preview = await previewWorkbook(resolve('Libro7.xlsx'), f.store);
    const broken = preview.rows.slice(0, 3).map((r, i) => ({ ...r, paid: i === 2 ? -1 : r.paid }));
    // A negative accumulated amount must never be silently discarded.
    assert.throws(() => f.store.importRows('invalido.xlsx', 'invalid', broken));
    assert.equal(f.store.snapshot().stats.count, 0);
    f.store.savePerson(input);
    const backupPath = join(f.folder, 'backup.sqlite');
    await backup(f.store.db, backupPath);
    const restored = new Store(backupPath, schema);
    try {
      restored.login({ username: 'admin', password: 'testing-password' });
      assert.equal(restored.snapshot().stats.count, 1);
    } finally { restored.close(); }
  } finally { f.cleanup(); }
});
