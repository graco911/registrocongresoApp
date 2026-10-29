import { useCallback, useEffect, useRef, useState } from 'react';
import type { Detail, Filters, Operator, Person, Snapshot } from '../shared/contracts';
import { money, time, Field, Status, type Run } from './ui';
import { PersonDialog, DetailDialog } from './Person';
import { Settings, ImportDialog, Operators } from './Settings';

const api = window.congress;
type Page = 'home' | 'people' | 'reception' | 'payments' | 'settings';
const titles: Record<Page, string> = { home: 'Resumen del congreso', people: 'Congresistas', reception: 'Recepción', payments: 'Pagos y adeudos', settings: 'Configuración' };
const initialFilters: Filters = { query: '', status: '', church: '', attendance: '', sessionId: null };
export function App() {
  const [bootstrap, setBootstrap] = useState<Awaited<ReturnType<typeof api.bootstrap>>>();
  const [user, setUser] = useState<Operator | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [people, setPeople] = useState<Person[]>([]);
  const [filters, setFilters] = useState(initialFilters);
  const [page, setPage] = useState<Page>('home');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [detail, setDetail] = useState<Detail>();
  const [edit, setEdit] = useState<Person | 'new'>();
  const [showImport, setShowImport] = useState(false);
  const [showOperators, setShowOperators] = useState(false);
  const [selected, setSelected] = useState<Person>();
  const search = useRef<HTMLInputElement>(null);
  const running = useRef(false);
  const run: Run = useCallback(async (task, success) => {
    if (running.current) return;
    running.current = true;
    setBusy(true); setError(''); setMessage('');
    try {
      const result = await task();
      if (success) setMessage(success);
      return result;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ocurrió un error inesperado.');
      return undefined;
    } finally { running.current = false; setBusy(false); }
  }, []);
  const reload = () => setRefresh(r => r + 1);
  const loadBootstrap = useCallback(async () => {
    const b = await api.bootstrap();
    setBootstrap(b); setUser(b.user);
    setSnapshot(undefined); setDetail(undefined); setEdit(undefined); setSelected(undefined);
    setPage('home'); setFilters(initialFilters);
  }, []);
  useEffect(() => { void run(loadBootstrap); }, [run, loadBootstrap]);
  useEffect(() => {
    if (!user) return;
    let active = true;
    api.snapshot().then(s => { if (active) setSnapshot(s); }).catch(e => { if (active) setError(String(e.message)); });
    return () => { active = false; };
  }, [user, refresh]);
  useEffect(() => {
    if (!user) return;
    let active = true;
    const timer = setTimeout(() => {
      api.list(filters).then(rows => {
        if (active) {
          setPeople(rows);
          setSelected(old => old ? rows.find(p => p.id === old.id) : undefined);
        }
      }).catch(e => { if (active) setError(String(e.message)); });
    }, 120);
    return () => { active = false; clearTimeout(timer); };
  }, [user, filters, refresh]);
  const openDetail = (id: number) => void run(async () => setDetail(await api.detail(id)));
  const changedDetail = async () => { if (detail) setDetail(await api.detail(detail.person.id)); reload(); };
  const canEdit = user?.role !== 'reception';
  const isAdmin = user?.role === 'admin';
  const selectedSession = snapshot?.sessions.find(s => s.id === filters.sessionId);
  function navigate(next: Page) {
    setPage(next); setSelected(undefined); setMessage(''); setError('');
    setFilters({ ...initialFilters, sessionId: next === 'reception' ? filters.sessionId : null });
  }
  if (!bootstrap) return <main className="loading"><h1>Registro Congreso</h1>{error ? <><p role="alert">{error}</p><button onClick={() => void run(loadBootstrap)}>Reintentar</button></> : <p>Abriendo base de datos…</p>}</main>;
  if (!user) return <main className="login">
    <section className="login-intro"><div className="brand-mark">C</div><p className="eyebrow">REGISTRO CONGRESO</p><h1>Cada persona,<br />bien recibida.</h1><p>Inscripciones, pagos y asistencia en un solo lugar. Sin depender de internet.</p><span className="offline">● Almacenamiento local</span></section>
    <section className="login-card">
      <p className="eyebrow">{bootstrap.needsSetup ? 'BIENVENIDO' : 'ACCESO DE OPERADORES'}</p>
      <h2>{bootstrap.needsSetup ? 'Prepara tu registro' : 'Iniciar sesión'}</h2>
      {bootstrap.needsSetup && <><p>Primero puedes cargar la base SQLite del Excel. Después crea la cuenta de administración.</p><button className="secondary" disabled={busy} onClick={() => void run(async () => { if (await api.loadInitial()) await loadBootstrap(); })}>Cargar base inicial SQLite</button><hr /></>}
      <form onSubmit={e => {
        e.preventDefault(); const f = new FormData(e.currentTarget);
        void run(async () => {
          const input = { username: String(f.get('username')), password: String(f.get('password')) };
          setUser(await (bootstrap.needsSetup ? api.setup(input) : api.login(input)));
        });
      }}>
        <Field label="Usuario"><input name="username" required minLength={3} maxLength={50} autoComplete="username" autoFocus /></Field>
        <Field label={bootstrap.needsSetup ? 'Contraseña (mínimo 10 caracteres)' : 'Contraseña'}><input name="password" type="password" required minLength={bootstrap.needsSetup ? 10 : 1} maxLength={128} autoComplete={bootstrap.needsSetup ? 'new-password' : 'current-password'} /></Field>
        {error && <p className="alert error" role="alert">{error}</p>}
        <button disabled={busy} className="wide">{busy ? 'Procesando…' : bootstrap.needsSetup ? 'Crear administrador' : 'Ingresar'}</button>
      </form>
      <p className="muted small">Los datos se guardan en este equipo. Conserva tus credenciales en un lugar seguro.</p>
    </section>
  </main>;
  return <div className="layout" aria-busy={busy}>
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark">C</div><div>Congreso<small>REGISTRO Y RECEPCIÓN</small></div></div>
      <nav aria-label="Navegación principal">{(['home', 'people', 'reception', ...(canEdit ? ['payments'] : []), ...(isAdmin ? ['settings'] : [])] as Page[]).map((p, i) =>
        <button key={p} className={page === p ? 'active' : ''} onClick={() => navigate(p)}><span aria-hidden="true">{['◫', '♙', '↳', '$', '⚙'][i]}</span>{({ home: 'Inicio', people: 'Congresistas', reception: 'Recepción', payments: 'Pagos', settings: 'Configuración' })[p]}</button>)}</nav>
      <div className="sidebar-bottom"><span className="offline">● Sin conexión requerida</span><strong>{user.username}</strong><small>{({ admin: 'Administración', cashier: 'Caja', reception: 'Recepción' })[user.role]}</small><button onClick={() => void run(async () => { await api.logout(); await loadBootstrap(); })}>Cerrar sesión</button></div>
    </aside>
    <main className="content">
      <header className="topbar"><span>{snapshot?.event.name ?? 'Congreso'}</span><span>{new Date().toLocaleDateString('es-MX', { day: 'numeric', month: 'long', year: 'numeric' })}</span></header>
      <div className="page-heading"><div><p className="eyebrow">GESTIÓN DEL EVENTO</p><h1>{titles[page]}</h1><p className="muted">{page === 'reception' ? 'Busca, verifica y registra el ingreso por sesión.' : 'Información clara para atender mejor a cada congresista.'}</p></div>
        {canEdit && page !== 'settings' && <button onClick={() => setEdit('new')}>＋ Nueva inscripción</button>}
      </div>
      {error && <div className="alert error" role="alert">{error}<button className="ghost" onClick={() => setError('')} aria-label="Cerrar error">✕</button></div>}
      {message && <div className="alert success" role="status">{message}</div>}
      {busy && <div className="working" role="status">Procesando…</div>}
      {snapshot && <>
        {page === 'home' ? <>
          <div className="stats">
            {[['Congresistas', String(snapshot.stats.count), 'Personas inscritas'], ['Recaudado', money(snapshot.stats.paid), 'Pagos y abonos vigentes'], ['Adeudos', money(snapshot.stats.balance), 'Saldo pendiente calculado'], ['Por revisar', String(snapshot.stats.issues), 'Incidencias de importación']].map(([label, value, note]) => <section className="stat" key={label}><span>{label}</span><strong>{value}</strong><small>{note}</small></section>)}
          </div>
          <div className="home-grid"><section className="card"><p className="eyebrow">LISTOS PARA RECIBIR</p><h2>Una recepción sin complicaciones</h2><p>Selecciona la sesión, encuentra a la persona y confirma su ingreso. El sistema evita marcas duplicadas.</p><button onClick={() => navigate('reception')}>Abrir recepción →</button></section>
            <section className="card"><h2>Sesiones del congreso</h2>{snapshot.sessions.map(s => <div className="session-row" key={s.id}><strong>{s.name}</strong><span>{s.session_date ?? 'Fecha por configurar'}</span></div>)}{isAdmin && <button className="secondary" onClick={() => navigate('settings')}>Configurar sesiones</button>}</section></div>
          {snapshot.stats.issues > 0 && <div className="alert warning">Hay {snapshot.stats.issues} incidencias por revisar. En Congresistas, abre los expedientes marcados con “Por revisar”.</div>}
        </> : page === 'settings' ? <Settings snapshot={snapshot} busy={busy} run={run} reload={reload} onRestore={loadBootstrap} showImport={() => setShowImport(true)} showOperators={() => setShowOperators(true)} databasePath={bootstrap.databasePath} /> : <>
          <section className="card filters">
            {page === 'reception' && <Field label="Sesión activa"><select aria-label="Sesión activa" value={filters.sessionId ?? ''} onChange={e => { setFilters({ ...filters, sessionId: Number(e.target.value) || null }); setSelected(undefined); }}><option value="">Selecciona una sesión</option>{snapshot.sessions.map(s => <option value={s.id} key={s.id}>{s.name} {s.session_date ? `· ${s.session_date}` : '· Sin fecha'}</option>)}</select></Field>}
            <Field label="Buscar congresista"><input ref={search} type="search" placeholder="Nombre, folio, teléfono o correo…" value={filters.query} onChange={e => { setFilters({ ...filters, query: e.target.value }); setSelected(undefined); }} onKeyDown={e => { if (e.key === 'Enter' && people.length === 1) { if (page === 'reception') setSelected(people[0]); else openDetail(people[0].id); } }} /></Field>
            <Field label="Estado de pago"><select value={filters.status} onChange={e => setFilters({ ...filters, status: e.target.value })}><option value="">Todos los pagos</option><option value="paid">Liquidado</option><option value="partial">Parcial</option><option value="pending">Pendiente</option></select></Field>
            <Field label="Iglesia"><select value={filters.church} onChange={e => setFilters({ ...filters, church: e.target.value })}><option value="">Todas las iglesias</option>{snapshot.churches.map(c => <option key={c}>{c}</option>)}</select></Field>
            {page === 'reception' && <Field label="Asistencia"><select disabled={!filters.sessionId} value={filters.attendance} onChange={e => setFilters({ ...filters, attendance: e.target.value })}><option value="">Todos</option><option value="yes">Ya ingresaron</option><option value="no">Sin ingreso</option></select></Field>}
          </section>
          {page === 'reception' && !selectedSession?.session_date && <div className="alert warning">Selecciona una sesión con fecha configurada para habilitar el check-in.</div>}
          {page === 'reception' && selected && <section className="card reception-card"><div><p className="eyebrow">{selected.folio} · {selectedSession?.name ?? 'Selecciona sesión'}</p><h2>{selected.full_name}</h2><p>{selected.church ?? 'Sin iglesia'} · {selected.city ?? 'Sin ciudad'}</p><Status value={selected.payment_status} /> <strong>Saldo: {money(selected.balance_cents)}</strong></div><div className="reception-actions">{selected.checked_in_at ? <strong className="checked">✓ Ya ingresó<br />{time(selected.checked_in_at)}</strong> : <button disabled={busy || !selectedSession?.session_date} onClick={() => void run(async () => {
            if (!filters.sessionId) throw new Error('Selecciona una sesión.');
            const result = await api.checkin({ registrationId: selected.id, sessionId: filters.sessionId });
            setMessage(`${result.existing ? 'Ingreso ya registrado' : 'Ingreso registrado'}: ${selected.full_name} · ${time(result.time)}`);
            reload(); search.current?.focus();
          })}>✓ Registrar ingreso</button>}<button className="secondary" onClick={() => openDetail(selected.id)}>Ver expediente</button></div></section>}
          <section className="table-card"><div className="table-title"><strong>{people.length} congresistas encontrados</strong>{canEdit && <button className="secondary" disabled={busy} onClick={() => void run(async () => { const path = await api.exportExcel(); if (path) setMessage(`Exportación guardada: ${path}`); })}>Exportar Excel</button>}</div>
            <div className="table-scroll"><table><thead><tr><th>Congresista</th><th>Iglesia / ciudad</th><th>Contacto</th><th>Pago</th><th>Saldo</th><th>{page === 'reception' ? 'Ingreso' : 'Expediente'}</th></tr></thead><tbody>{people.map(p => <tr key={p.id} className={selected?.id === p.id ? 'selected' : ''}><td><button className="text-button name" onClick={() => page === 'reception' ? setSelected(p) : openDetail(p.id)}>{p.full_name}</button><small>{p.folio}{p.issue_count > 0 ? ' · ⚑ Por revisar' : ''}</small></td><td>{p.church ?? '—'}<small>{p.city ?? 'Sin ciudad'}</small></td><td>{p.phone ?? 'Sin teléfono'}<small>{p.email ?? 'Sin correo'}</small></td><td><Status value={p.payment_status} /></td><td className={p.balance_cents ? 'debt' : ''}>{money(p.balance_cents)}</td><td><button className="secondary" onClick={() => page === 'reception' ? setSelected(p) : openDetail(p.id)}>{page === 'reception' ? p.checked_in_at ? '✓ Ver ingreso' : 'Seleccionar' : 'Ver detalle'}</button></td></tr>)}</tbody></table></div>
            {!people.length && <div className="empty"><h3>No hay coincidencias</h3><p>Prueba otro nombre o modifica los filtros.</p></div>}
          </section>
        </>}
        {edit && <PersonDialog person={edit === 'new' ? undefined : edit} snapshot={snapshot} user={user} busy={busy} run={run} close={() => setEdit(undefined)} saved={id => { setEdit(undefined); reload(); void api.detail(id).then(setDetail).catch(e => setError(e.message)); }} />}
        {detail && <DetailDialog detail={detail} snapshot={snapshot} user={user} busy={busy} run={run} close={() => setDetail(undefined)} edit={() => { setEdit(detail.person); setDetail(undefined); }} changed={changedDetail} />}
        {showImport && <ImportDialog busy={busy} run={run} close={() => setShowImport(false)} saved={() => { setShowImport(false); reload(); }} />}
        {showOperators && <Operators user={user} busy={busy} run={run} close={() => setShowOperators(false)} />}
      </>}
    </main>
  </div>;
}
