import { app, BrowserWindow, dialog, ipcMain, Menu } from 'electron';
import { backup, DatabaseSync } from 'node:sqlite';
import { mkdir, rename, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { AppError, Store } from './store';
import { exportWorkbook, previewWorkbook } from './workbook';
import { methods, type Method, type Reply, type ImportPreview } from '../shared/contracts';

let window: BrowserWindow;
let store: Store;
let databasePath: string;
let staged: (ImportPreview & { hash: string }) | null = null;
let queue: Promise<unknown> = Promise.resolve();
const schema = join(__dirname, 'schema.sql');

async function validateDatabase(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const version = Number(db.prepare('PRAGMA user_version').get()!.user_version);
    if (![1, 2].includes(version)) throw new AppError('Versión de respaldo no compatible.');
    if (db.prepare('PRAGMA integrity_check').get()!.integrity_check !== 'ok') throw new AppError('El respaldo está dañado.');
    db.exec('PRAGMA foreign_keys=ON');
    if (db.prepare('PRAGMA foreign_key_check').all().length) throw new AppError('El respaldo contiene relaciones inválidas.');
    db.prepare('SELECT full_name FROM attendees LIMIT 1').all();
    db.prepare('SELECT balance_cents FROM registration_balances LIMIT 1').all();
    if (!db.prepare('SELECT name FROM events WHERE id=1').get()) throw new AppError('El respaldo no contiene el evento principal.');
    if (version === 2) {
      if (!Number(db.prepare("SELECT count(*) n FROM operators WHERE active=1 AND role='admin'").get()!.n)) throw new AppError('El respaldo no tiene un administrador activo.');
    }
  } finally { db.close(); }
}
async function replaceDatabase(path: string) {
  if (resolve(path).toLowerCase() === resolve(databasePath).toLowerCase()) throw new AppError('Selecciona otro archivo, no la base que está abierta.');
  await validateDatabase(path);
  const temporary = databasePath + '.restore';
  const source = new DatabaseSync(path, { readOnly: true });
  try { await backup(source, temporary); }
  finally { source.close(); }
  let replacement: Store | undefined;
  try {
    replacement = new Store(temporary, schema);
    replacement.close();
    replacement = undefined;
    await mkdir(join(app.getPath('userData'), 'backups'), { recursive: true });
    await backup(store.db, join(app.getPath('userData'), 'backups', `antes-restaurar-${Date.now()}.sqlite`));
    store.close();
    try { await rename(temporary, databasePath); }
    finally { store = new Store(databasePath, schema); }
    staged = null;
  } finally {
    replacement?.close();
    if (existsSync(temporary)) await rm(temporary);
  }
}
async function chooseDatabase() {
  const result = await dialog.showOpenDialog(window, { title: 'Seleccionar base SQLite', properties: ['openFile'], filters: [{ name: 'SQLite', extensions: ['sqlite', 'db'] }] });
  return result.canceled ? null : result.filePaths[0];
}
async function dispatch(method: Method, input: unknown): Promise<unknown> {
  switch (method) {
    case 'bootstrap': return { needsSetup: store.needsSetup(), user: store.user, databasePath };
    case 'setup': return store.setup(input);
    case 'login': return store.login(input);
    case 'logout': store.user = null; staged = null; return;
    case 'loadInitial': {
      if (!store.needsSetup()) throw new AppError('La base inicial solo se carga antes de crear el administrador.');
      const path = await chooseDatabase();
      if (!path) return false;
      await replaceDatabase(path);
      return true;
    }
    case 'snapshot': return store.snapshot();
    case 'list': return store.list(z.object({ query: z.string(), status: z.string(), church: z.string(), attendance: z.string(), sessionId: z.number().nullable() }).parse(input));
    case 'detail': return store.detail(input);
    case 'savePerson': return store.savePerson(input);
    case 'addPayment': return store.addPayment(input);
    case 'voidPayment': return store.voidPayment(input);
    case 'checkin': return store.checkin(input);
    case 'voidCheckin': return store.voidCheckin(input);
    case 'resolveIssue': return store.resolveIssue(input);
    case 'saveSettings': return store.saveSettings(input);
    case 'operators': return store.operators();
    case 'addOperator': return store.addOperator(input);
    case 'disableOperator': return store.disableOperator(input);
    case 'previewImport': {
      store.require('admin');
      staged = null;
      const result = await dialog.showOpenDialog(window, { filters: [{ name: 'Excel', extensions: ['xlsx'] }], properties: ['openFile'] });
      if (result.canceled) return null;
      staged = await previewWorkbook(result.filePaths[0], store);
      return { token: staged.token, filename: staged.filename, rows: staged.rows };
    }
    case 'commitImport': {
      store.require('admin');
      const p = z.object({ token: z.string(), rows: z.array(z.number().int().positive()).min(1) }).parse(input);
      if (!staged || staged.token !== p.token) throw new AppError('La vista previa venció; vuelve a seleccionar el archivo.');
      const selected = new Set(p.rows);
      const rows = staged.rows.filter(r => selected.has(r.row));
      if (rows.length !== selected.size) throw new AppError('Selección de filas inválida.');
      const count = store.importRows(staged.filename, staged.hash, rows);
      staged = null;
      return count;
    }
    case 'exportExcel': {
      store.require('admin', 'cashier');
      const result = await dialog.showSaveDialog(window, { defaultPath: `Congresistas-${new Date().toISOString().slice(0, 10)}.xlsx`, filters: [{ name: 'Excel', extensions: ['xlsx'] }] });
      if (result.canceled || !result.filePath) return null;
      await exportWorkbook(result.filePath, store);
      store.audit('export');
      return result.filePath;
    }
    case 'backup': {
      store.require('admin');
      const result = await dialog.showSaveDialog(window, { defaultPath: `Congreso-${new Date().toISOString().slice(0, 10)}.sqlite`, filters: [{ name: 'SQLite', extensions: ['sqlite'] }] });
      if (result.canceled || !result.filePath) return null;
      if (resolve(result.filePath).toLowerCase() === resolve(databasePath).toLowerCase()) throw new AppError('El respaldo debe guardarse en otro archivo.');
      await backup(store.db, result.filePath);
      store.audit('backup');
      return result.filePath;
    }
    case 'restore': {
      store.require('admin');
      const path = await chooseDatabase();
      if (!path) return false;
      const confirmation = await dialog.showMessageBox(window, {
        type: 'warning', buttons: ['Cancelar', 'Restaurar'], defaultId: 0, cancelId: 0,
        message: '¿Reemplazar los datos actuales?',
        detail: 'Se guardará un respaldo previo. Después deberás ingresar con los usuarios del respaldo; si es una base inicial, crearás un administrador.',
      });
      if (confirmation.response !== 1) return false;
      await replaceDatabase(path);
      return true;
    }
  }
}
if (process.env.CONGRESO_DATA_DIR) app.setPath('userData', resolve(process.env.CONGRESO_DATA_DIR));
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.focus(); } });
  app.whenReady().then(async () => {
    await mkdir(app.getPath('userData'), { recursive: true });
    databasePath = join(app.getPath('userData'), 'congreso.sqlite');
    store = new Store(databasePath, schema);
    // A rotating startup copy protects the previous working session.
    if (!store.needsSetup()) {
      const folder = join(app.getPath('userData'), 'backups');
      await mkdir(folder, { recursive: true });
      await backup(store.db, join(folder, `inicio-${new Date().getDay()}.sqlite`));
    }
    window = new BrowserWindow({
      width: 1400, height: 900, minWidth: 1050, minHeight: 700, title: 'Registro Congreso',
      backgroundColor: '#f4f6f7',
      webPreferences: { preload: join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    Menu.setApplicationMenu(null);
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    const origin = process.env.CONGRESO_DEV === '1' ? 'http://127.0.0.1:5173' : null;
    ipcMain.handle('congress', async (event, method: unknown, input: unknown): Promise<Reply> => {
      try {
        const url = event.senderFrame?.url ?? '';
        if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame ||
            (origin ? !url.startsWith(origin + '/') : !url.startsWith('file://'))) throw new AppError('Origen no autorizado.');
        const parsed = z.enum(methods).parse(method);
        const operation = queue.then(() => dispatch(parsed, input));
        queue = operation.then(() => undefined, () => undefined);
        return { ok: true, value: await operation };
      } catch (error) {
        console.error('Operación fallida:', method, error);
        const message = error instanceof AppError ? error.message :
          error instanceof z.ZodError ? error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('\n') :
          'No se pudo completar la operación. Verifica el archivo, los permisos y el espacio disponible.';
        return { ok: false, error: message };
      }
    });
    if (origin) await window.loadURL(origin);
    else await window.loadFile(join(__dirname, '../renderer/index.html'));
  }).catch(error => {
    console.error(error);
    dialog.showErrorBox('No se pudo iniciar Registro Congreso', error instanceof Error ? error.message : String(error));
    app.quit();
  });
  app.on('window-all-closed', () => app.quit());
  app.on('will-quit', () => store?.close());
}
