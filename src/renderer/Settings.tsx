import { useEffect, useState } from 'react';
import type { ImportPreview, Operator, Session, Snapshot } from '../shared/contracts';
import { cents, Field, Modal, money, type Run } from './ui';

const api = window.congress;
export function Settings({ snapshot, busy, run, reload, onRestore, showImport, showOperators, databasePath }: {
  snapshot: Snapshot; busy: boolean; run: Run; reload: () => void; onRestore: () => Promise<void>;
  showImport: () => void; showOperators: () => void; databasePath: string;
}) {
  const toDraft = (sessions: Session[]) => sessions.map(s => ({ ...s, key: crypto.randomUUID() }));
  const [sessions, setSessions] = useState<(Omit<Session, 'id'> & { id?: number; key: string })[]>(() => toDraft(snapshot.sessions));
  const [notice, setNotice] = useState('');
  useEffect(() => setSessions(toDraft(snapshot.sessions)), [snapshot.sessions]);
  return <div className="settings-grid"><section className="card">
    <h2>Evento y sesiones</h2><form onSubmit={e => {
      e.preventDefault(); const f = new FormData(e.currentTarget);
      void run(async () => {
        await api.saveSettings({ name: String(f.get('name')), default_fee_cents: cents(f.get('fee')), allow_debt: f.get('allow_debt') === 'on', sessions: sessions.map(s => ({ ...s, session_date: s.session_date ?? '' })) });
        reload();
      }, 'Configuración guardada.');
    }}>
      <Field label="Nombre del congreso"><input name="name" defaultValue={snapshot.event.name} required maxLength={500} /></Field>
      <Field label="Tarifa para nuevas inscripciones (MXN)"><input name="fee" type="number" step="0.01" min="0" max="1000000" defaultValue={snapshot.event.default_fee_cents / 100} required /></Field>
      <label className="checkbox"><input type="checkbox" name="allow_debt" defaultChecked={!!snapshot.event.allow_debt} /> Permitir ingreso con adeudo</label>
      <p className="muted small">La tarifa de las inscripciones existentes no cambia. Las fechas de sesiones deben confirmarse antes de registrar ingresos.</p>
      <h3>Sesiones</h3>
      <p className="muted small">Debe existir al menos una sesión. Los cambios se aplican al guardar. No se pueden quitar sesiones con ingresos, aunque estén anulados.</p>
      {sessions.map((s, i) => <div className="session-draft" key={s.key}><div className="session-edit">
        <Field label="Nombre"><input value={s.name} required maxLength={500} onChange={e => setSessions(old => old.map((v, j) => j === i ? { ...v, name: e.target.value } : v))} /></Field>
        <Field label="Fecha completa"><input type="date" value={s.session_date ?? ''} onChange={e => setSessions(old => old.map((v, j) => j === i ? { ...v, session_date: e.target.value } : v))} /></Field>
      </div><button type="button" className="secondary danger" aria-label={`Quitar sesión ${s.name || i + 1}`} disabled={busy || sessions.length === 1} onClick={() => setSessions(old => old.filter(v => v.key !== s.key))}>Quitar sesión</button></div>)}
      <div className="actions"><button type="button" className="secondary" disabled={busy || sessions.length >= 30} onClick={() => setSessions([...sessions, { name: '', session_date: null, key: crypto.randomUUID() }])}>＋ Agregar sesión</button><button disabled={busy}>Guardar configuración</button></div>
    </form>
  </section><div className="settings-side"><section className="card"><h2>Datos y archivos</h2><p>Importa con vista previa y exporta el registro, pagos y asistencia.</p>{notice && <p role="status" className="alert success">{notice}</p>}<div className="stack"><button className="secondary" onClick={showImport}>Importar Excel</button><button className="secondary" disabled={busy} onClick={() => void run(async () => { setNotice(''); const path = await api.exportExcel(); if (path) setNotice(`Guardado: ${path}`); })}>Exportar Excel</button><button className="secondary" disabled={busy} onClick={() => void run(async () => {
      setNotice('');
      const path = await api.backup();
      if (path) setNotice(`Respaldo guardado: ${path}`);
    })}>Crear respaldo SQLite</button><button className="secondary danger" disabled={busy} onClick={() => void run(async () => { if (await api.restore()) await onRestore(); })}>Restaurar respaldo</button></div></section>
    <section className="card"><h2>Operadores</h2><p>Administración, caja y recepción tienen permisos distintos.</p><button className="secondary" onClick={showOperators}>Administrar operadores</button></section>
    <section className="card"><h3>Almacenamiento local</h3><p className="path">{databasePath}</p><p className="muted small">Se guarda un respaldo al iniciar, rotado por día de la semana. Copia respaldos a otro dispositivo. La base no está cifrada.</p></section>
  </div></div>;
}
export function ImportDialog({ busy, run, close, saved }: { busy: boolean; run: Run; close: () => void; saved: () => void }) {
  const [preview, setPreview] = useState<ImportPreview>();
  const [selected, setSelected] = useState<Set<number>>(new Set());
  return <Modal title="Importar registro de Excel" close={close}><div className="dialog-body">
    <p>Usa la plantilla de Libro7.xlsx: hoja Inscripciones y encabezados en fila 7. Las coincidencias no se fusionan automáticamente.</p>
    <button disabled={busy} onClick={() => void run(async () => {
      const result = await api.previewImport();
      if (result) { setPreview(result); setSelected(new Set(result.rows.filter(r => !r.duplicate).map(r => r.row))); }
    })}>Seleccionar archivo Excel</button>
    {preview && <><h3>{preview.filename}</h3><p>{selected.size} seleccionados de {preview.rows.length} · Pagado seleccionado: {money(preview.rows.filter(r => selected.has(r.row)).reduce((sum, r) => sum + r.paid, 0))}</p>
      <div className="alert warning">Revisa las advertencias. Cada fila seleccionada creará una inscripción nueva con la tarifa actual; los cambios a registros existentes se realizan en su expediente.</div>
      <div className="import-list">{preview.rows.map(row => <label className="import-row" key={row.row}><input type="checkbox" checked={selected.has(row.row)} onChange={e => setSelected(old => {
        const next = new Set(old); if (e.target.checked) next.add(row.row); else next.delete(row.row); return next;
      })} /><div><strong>Fila {row.row} · {row.name}</strong><p>{row.church ?? 'Sin iglesia'} · {money(row.paid)}</p>{row.warnings.map((w, i) => <small className="debt" key={i}>{w}</small>)}</div></label>)}</div>
      <p className="muted small">Las filas excluidas no se importan. Tras confirmar, el archivo queda registrado como procesado; para incluirlas, completa la selección antes de confirmar.</p>
      <div className="actions"><button className="secondary" onClick={close}>Cancelar</button><button disabled={busy || !selected.size} onClick={() => void run(async () => {
        await api.commitImport({ token: preview.token, rows: [...selected] }); saved();
      }, 'Importación completada.')}>Confirmar importación ({selected.size})</button></div>
    </>}
  </div></Modal>;
}
export function Operators({ user, busy, run, close }: { user: Operator; busy: boolean; run: Run; close: () => void }) {
  const [rows, setRows] = useState<(Operator & { active: number })[]>([]);
  const [error, setError] = useState('');
  const reload = async () => setRows(await api.operators());
  useEffect(() => { void reload().catch(e => setError(e.message)); }, []);
  return <Modal title="Operadores y permisos" close={close}><div className="dialog-body">
    {error && <p role="alert" className="alert error">{error}</p>}
    {rows.map(o => <article key={o.id} className="movement"><div><strong>{o.username}</strong><p>{({ admin: 'Administración', cashier: 'Caja', reception: 'Recepción' })[o.role]} · {o.active ? 'Activo' : 'Inactivo'}</p></div>{!!o.active && o.id !== user.id && <button className="secondary danger" disabled={busy} onClick={() => void run(async () => { await api.disableOperator(o.id); await reload(); })}>Desactivar</button>}</article>)}
    <h3>Crear operador</h3><form onSubmit={e => {
      e.preventDefault(); const form = e.currentTarget; const f = new FormData(form);
      const role = String(f.get('role'));
      if (role !== 'admin' && role !== 'cashier' && role !== 'reception') return;
      void run(async () => {
        await api.addOperator({ username: String(f.get('username')), password: String(f.get('password')), role });
        form.reset(); await reload();
      }, 'Operador creado.');
    }}><div className="form-grid">
      <Field label="Usuario"><input name="username" required minLength={3} maxLength={50} autoComplete="off" /></Field>
      <Field label="Contraseña (mínimo 10 caracteres)"><input name="password" type="password" required minLength={10} maxLength={128} autoComplete="new-password" /></Field>
      <Field label="Permisos"><select name="role"><option value="reception">Recepción: consultar e ingresar</option><option value="cashier">Caja: inscribir y cobrar</option><option value="admin">Administración: control completo</option></select></Field>
    </div><div className="actions"><button disabled={busy}>Crear operador</button></div></form>
  </div></Modal>;
}
