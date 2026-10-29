import { _electron as electron, expect } from '@playwright/test';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import ExcelJS from 'exceljs';

const folder = await mkdtemp(join(tmpdir(), 'congreso-desktop-'));
const artifacts = resolve('test-results');
await mkdir(artifacts, { recursive: true });
let app;
let page;
const pageErrors = [];
async function launch() {
  app = await electron.launch({
    ...(process.env.CONGRESO_EXECUTABLE ? { executablePath: resolve(process.env.CONGRESO_EXECUTABLE) } : {}),
    args: process.env.CONGRESO_EXECUTABLE ? [] : [resolve('.')],
    env: { ...process.env, CONGRESO_DATA_DIR: folder, CONGRESO_DEV: '0' },
  });
  page = await app.firstWindow();
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.waitForLoadState('domcontentloaded');
}
async function login(username, password) {
  await page.getByLabel('Usuario', { exact: true }).fill(username);
  await page.getByLabel('Contraseña', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Ingresar', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Resumen del congreso' })).toBeVisible();
}
async function nav(name) { await page.getByRole('navigation').getByRole('button', { name, exact: true }).click(); }
try {
  await launch();
  await expect(page.getByRole('heading', { name: 'Prepara tu registro' })).toBeVisible();
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, resolve('data/congreso.sqlite'));
  await page.getByRole('button', { name: 'Cargar base inicial SQLite' }).click();
  await expect(page.getByRole('button', { name: 'Crear administrador' })).toBeEnabled();
  await page.getByLabel('Usuario', { exact: true }).fill('admin');
  await page.getByLabel('Contraseña (mínimo 10 caracteres)').fill('testing-password');
  await page.getByRole('button', { name: 'Crear administrador' }).click();
  await expect(page.getByRole('heading', { name: 'Resumen del congreso' })).toBeVisible();
  await expect(page.locator('.stat').first()).toContainText('51');
  await page.screenshot({ path: join(artifacts, 'inicio.png'), fullPage: true });

  await nav('Configuración');
  await page.getByRole('button', { name: /^Quitar sesión/ }).nth(1).click();
  await expect(page.locator('.session-edit')).toHaveCount(1);
  await expect(page.getByRole('button', { name: /^Quitar sesión/ })).toBeDisabled();
  await page.getByRole('button', { name: 'Guardar configuración' }).click();
  await expect(page.getByRole('status')).toContainText('Configuración guardada');
  await nav('Inicio');
  await expect(page.locator('.session-row')).toHaveCount(1);
  await nav('Configuración');
  await page.getByRole('button', { name: 'Agregar sesión' }).click();
  await page.locator('.session-edit').nth(1).getByLabel('Nombre', { exact: true }).fill('Sábado 14');
  await expect(page.getByRole('button', { name: /^Quitar sesión/ }).first()).toBeEnabled();
  await page.getByRole('button', { name: 'Agregar sesión' }).click();
  await page.locator('.session-edit').nth(2).getByLabel('Nombre', { exact: true }).fill('Temporal');
  await page.getByRole('button', { name: 'Quitar sesión Sábado 14', exact: true }).click();
  await expect(page.locator('.session-edit').nth(1).getByLabel('Nombre', { exact: true })).toHaveValue('Temporal');
  await page.locator('.session-edit').nth(1).getByLabel('Nombre', { exact: true }).fill('Sábado 14');
  const dates = page.locator('.session-edit input[type=date]');
  await dates.nth(0).fill('2026-11-13');
  await dates.nth(1).fill('2026-11-14');
  await page.getByRole('button', { name: 'Guardar configuración' }).click();
  await expect(page.getByRole('status')).toContainText('Configuración guardada');
  await page.getByRole('button', { name: 'Administrar operadores' }).click();
  let modal = page.getByRole('dialog');
  await modal.getByLabel('Usuario', { exact: true }).fill('entrada');
  await modal.getByLabel('Contraseña (mínimo 10 caracteres)').fill('password-entrada');
  await modal.getByRole('button', { name: 'Crear operador', exact: true }).click();
  await expect(modal.getByText('entrada', { exact: true })).toBeVisible();
  await modal.getByRole('button', { name: 'Cerrar ventana' }).click();

  await nav('Congresistas');
  await page.getByRole('button', { name: 'Nueva inscripción' }).click();
  modal = page.getByRole('dialog');
  await modal.getByLabel('Nombre completo *', { exact: true }).fill('María José Pérez');
  const phone = modal.getByLabel('Teléfono / WhatsApp');
  await phone.pressSequentially('9931234567');
  await expect(phone).toHaveValue('(993) 123-4567');
  await phone.press('Backspace');
  await expect(phone).toHaveValue('(993) 123-456');
  await phone.press('7');
  await phone.fill('993');
  await expect(phone).toHaveValue('(993)');
  await phone.press('Backspace');
  await expect(phone).toHaveValue('(99');
  await phone.fill('+52 9931234567');
  await expect(phone).toHaveValue('+52 (993) 123-4567');
  await phone.fill('(993) 123-4567');
  await phone.evaluate(input => { input.focus(); input.setSelectionRange(6, 6); });
  await phone.press('Backspace');
  await expect(phone).toHaveValue('(991) 234-567');
  await phone.fill('993123456');
  await modal.getByLabel('Correo electrónico').fill(' maria @ example.test ');
  await expect(modal.getByLabel('Correo electrónico')).toHaveValue('maria@example.test');
  await modal.getByRole('button', { name: 'Guardar inscripción' }).click();
  await expect(phone).toBeVisible();
  expect(await phone.evaluate(input => input.checkValidity())).toBe(false);
  await phone.fill('9931234567');
  await modal.getByLabel('Iglesia / congregación').fill('Sinaí');
  await modal.getByLabel('Cargo', { exact: true }).fill('Anciano');
  await modal.getByLabel('Ciudad / municipio').fill('Comalcalco');
  await modal.getByRole('button', { name: 'Guardar inscripción' }).click();
  await expect(modal.getByRole('heading', { name: 'María José Pérez' })).toBeVisible();
  await expect(modal).toContainText('9931234567');
  await expect(modal).toContainText('maria@example.test');
  await modal.getByRole('button', { name: 'Editar datos', exact: true }).click();
  await expect(modal.getByLabel('Teléfono / WhatsApp')).toHaveValue('(993) 123-4567');
  await modal.getByLabel('Teléfono / WhatsApp').fill('+529931234567');
  await modal.getByRole('button', { name: 'Guardar inscripción' }).click();
  await expect(modal.getByRole('heading', { name: 'María José Pérez' })).toBeVisible();
  await expect(modal).toContainText('+529931234567');
  await modal.getByRole('button', { name: 'Pagos', exact: true }).click();
  await modal.getByRole('button', { name: 'Registrar abono' }).click();
  await modal.getByLabel('Importe (MXN)').fill('100');
  await modal.getByRole('button', { name: 'Guardar abono' }).click();
  await expect(modal.locator('.badge').first()).toHaveText('Parcial');
  await modal.getByRole('button', { name: 'Registrar abono' }).click();
  await modal.getByRole('button', { name: 'Guardar abono' }).click();
  await expect(modal.locator('.badge').first()).toHaveText('Liquidado');
  await modal.getByRole('button', { name: 'Anular pago' }).first().click();
  await modal.getByLabel('Motivo obligatorio').fill('Prueba de corrección');
  await modal.getByRole('button', { name: 'Confirmar anulación' }).click();
  await expect(modal.locator('.badge').first()).toHaveText('Parcial');
  await modal.getByRole('button', { name: 'Registrar abono' }).click();
  await modal.getByRole('button', { name: 'Guardar abono' }).click();
  await expect(modal.locator('.badge').first()).toHaveText('Liquidado');
  await modal.getByRole('button', { name: 'Cerrar ventana' }).click();

  await nav('Recepción');
  await page.getByLabel('Sesión activa').selectOption({ label: 'Viernes 13 · 2026-11-13' });
  await page.getByLabel('Buscar congresista').fill('maria perez');
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await page.getByRole('button', { name: 'Seleccionar', exact: true }).click();
  await page.getByRole('button', { name: /Registrar ingreso/ }).click();
  await expect(page.getByRole('status')).toContainText('Ingreso registrado');
  await expect(page.locator('.checked')).toContainText('Ya ingresó');
  const duplicate = await page.evaluate(async () => {
    const [person] = await window.congress.list({ query: 'maria perez', status: '', church: '', attendance: '', sessionId: 1 });
    return window.congress.checkin({ registrationId: person.id, sessionId: 1 });
  });
  expect(duplicate.existing).toBe(true);
  await page.screenshot({ path: join(artifacts, 'recepcion.png'), fullPage: true });

  await nav('Configuración');
  await page.getByRole('button', { name: 'Quitar sesión Viernes 13', exact: true }).click();
  await page.getByRole('button', { name: 'Guardar configuración' }).click();
  await expect(page.getByRole('alert')).toContainText('tiene ingresos registrados');
  await nav('Inicio');
  await expect(page.locator('.session-row')).toHaveCount(2);
  await nav('Configuración');
  const backupPath = join(folder, 'manual.sqlite');
  await app.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
  }, backupPath);
  await page.getByRole('button', { name: 'Crear respaldo SQLite' }).click();
  await expect(page.getByRole('status')).toContainText('Respaldo guardado');
  const exportPath = join(folder, 'reporte.xlsx');
  await app.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
  }, exportPath);
  await page.getByRole('button', { name: 'Exportar Excel' }).click();
  await expect(page.getByRole('status')).toContainText('Guardado');

  await page.getByRole('button', { name: 'Cerrar sesión' }).click();
  await login('entrada', 'password-entrada');
  await expect(page.getByRole('navigation').getByRole('button', { name: 'Configuración' })).toHaveCount(0);
  const denied = await page.evaluate(async () => {
    try { await window.congress.addPayment({}); return false; }
    catch (error) { return error.message.includes('permiso'); }
  });
  expect(denied).toBe(true);
  await app.close(); app = undefined;

  await launch();
  await login('admin', 'testing-password');
  await expect(page.locator('.stat').first()).toContainText('52');
  await nav('Congresistas');
  await page.getByLabel('Buscar congresista').fill('maria perez');
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await expect(page.locator('tbody')).toContainText('Liquidado');
  await nav('Configuración');
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
  }, backupPath);
  await page.getByRole('button', { name: 'Restaurar respaldo' }).click();
  await expect(page.getByRole('heading', { name: 'Iniciar sesión' })).toBeVisible();
  await login('admin', 'testing-password');
  await expect(page.locator('.stat').first()).toContainText('52');
  // Restore a clean version-1 database and exercise the Excel preview/commit IPC.
  await nav('Configuración');
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, resolve('data/congreso.sqlite'));
  await page.getByRole('button', { name: 'Restaurar respaldo' }).click();
  await expect(page.getByRole('heading', { name: 'Prepara tu registro' })).toBeVisible();
  await page.getByLabel('Usuario', { exact: true }).fill('nuevo-admin');
  await page.getByLabel('Contraseña (mínimo 10 caracteres)').fill('testing-password');
  await page.getByRole('button', { name: 'Crear administrador' }).click();
  await expect(page.getByRole('heading', { name: 'Resumen del congreso' })).toBeVisible();
  await nav('Configuración');
  await page.getByRole('button', { name: 'Importar Excel' }).click();
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, resolve('Libro7.xlsx'));
  await page.getByRole('dialog').getByRole('button', { name: 'Seleccionar archivo Excel' }).click();
  await expect(page.getByRole('alert')).toContainText('ya fue importado');
  await page.getByRole('button', { name: 'Cerrar error' }).click();
  const importPath = join(folder, 'nuevos.xlsx');
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('Inscripciones');
  worksheet.getCell('C7').value = 'Nombre completo';
  worksheet.getCell('H7').value = 'Monto pagado';
  worksheet.getCell('C8').value = 'Ana Prueba de Importación';
  worksheet.getCell('H8').value = 100;
  worksheet.getCell('J8').value = 'Parcial';
  worksheet.getCell('G8').value = 'Regalo entregado';
  await workbook.xlsx.writeFile(importPath);
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, importPath);
  await page.getByRole('dialog').getByRole('button', { name: 'Seleccionar archivo Excel' }).click();
  await expect(page.getByRole('dialog').getByText('Fila 8 · Ana Prueba de Importación')).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Confirmar importación (1)' }).click();
  await expect(page.getByRole('status')).toContainText('Importación completada');
  await app.close(); app = undefined;

  const db = new DatabaseSync(join(folder, 'congreso.sqlite'), { readOnly: true });
  try {
    expect(db.prepare('SELECT count(*) n FROM registrations').get().n).toBe(52);
    expect(db.prepare('SELECT count(*) n FROM checkins').get().n).toBe(0);
    expect(db.prepare('PRAGMA integrity_check').get().integrity_check).toBe('ok');
  } finally { db.close(); }
  expect(pageErrors).toEqual([]);
  console.log('OK: Electron real, base inicial, alta, pagos, anulación, búsqueda, check-in, permisos, exportación, respaldo, reinicio y restauración.');
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: join(artifacts, 'failure.png'), fullPage: true });
  throw error;
} finally {
  if (app) await app.close();
  await rm(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
