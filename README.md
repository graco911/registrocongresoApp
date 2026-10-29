# Registro Congreso

Aplicacion de escritorio para Windows x64, construida con Electron, React,
TypeScript y SQLite. Funciona sin internet en **una computadora**. La base no
debe compartirse directamente por red; varios puestos simultaneos requieren
un servicio central, fuera del alcance de esta version.

## Instalar y comenzar

1. Ejecutar `release\Registro-Congreso-1.0.0-Setup.exe`.
2. Abrir **Registro Congreso** desde el acceso directo.
3. Antes de crear el administrador, elegir **Cargar base inicial SQLite** y
   seleccionar `data\congreso.sqlite` para incorporar los 51 registros del Excel.
   La aplicacion trabaja sobre una copia: no modifica esa base inicial.
4. Crear un usuario administrador con contrasena de al menos 10 caracteres.
5. En **Configuracion**, confirmar nombre del evento, tarifa, politica de
   ingreso con adeudo y fechas completas de las sesiones. Las fechas originales
   no se deducen ni se completan automaticamente.
6. Crear operadores de caja o recepcion si se necesitan.

El instalador **no incluye datos personales, cuentas ni contrasenas**. Puede
usarse tambien sin cargar la base inicial, comenzando con un registro vacio.
No requiere Node.js, Excel ni una terminal en los equipos de los operadores.
El ejecutable no esta firmado con certificado comercial: Windows puede mostrar
una advertencia de editor desconocido.

## Funcionalidades

- **Inicio:** inscritos, recaudacion, saldo calculado e incidencias.
- **Congresistas:** busqueda por nombre, folio, telefono, correo, iglesia o ciudad,
  sin distinguir acentos ni mayusculas; filtros por iglesia y estado de pago.
- **Expediente:** datos de contacto y procedencia, observaciones, pagos,
  asistencias y datos originales de importacion.
- **Alta y edicion:** valida contactos, fechas e importes; advierte posibles
  coincidencias por nombre antes de crear otra persona. No fusiona homonimos.
  El telefono usa mascara mexicana `(993) 123-4567`, con `+52` opcional y
  exactamente 10 digitos nacionales; se guarda sin separadores. El correo
  elimina espacios al capturar y al guardar, y valida `usuario@dominio.ext`
  sin restringir el proveedor ni cambiar mayusculas. Ambos son opcionales.
  No se modifican contactos existentes hasta guardar su expediente; la
  importacion conserva sus datos originales para revision.
- **Pagos:** abonos, forma, fecha, referencia y operador; estados y saldos
  calculados. Un excedente requiere confirmacion en la interfaz.
- **Recepcion:** seleccion de sesion, busqueda y check-in. Muestra ingresos
  previos y evita duplicarlos. Requiere fecha completa en la sesion.
- **Sesiones:** administracion puede editar nombres y fechas, agregar y quitar
  sesiones desde Configuracion (entre 1 y 30). Los cambios se aplican al guardar.
  No se permite quitar sesiones con ingresos registrados, incluso anulados,
  para conservar su historial. Nunca se permite dejar el evento sin sesiones.
- **Importacion Excel:** vista previa de la plantilla original, advertencias y
  seleccion de filas; excluye inicialmente posibles coincidencias. Una
  importacion crea registros nuevos, no actualiza expedientes existentes.
- **Exportacion Excel:** hojas de congresistas, pagos y asistencia.
- **Respaldos:** copia SQLite consistente, restauracion con confirmacion y copia
  previa de seguridad; respaldo de inicio rotado en siete archivos semanales.
- **Auditoria:** registra cambios de datos, movimientos, anulaciones, ingresos,
  operadores y configuracion en `audit_log`.

### Permisos

| Operacion | Administracion | Caja | Recepcion |
|---|---|---|---|
| Buscar, consultar expediente y registrar ingreso | Si | Si | Si |
| Inscribir, editar contacto, registrar abonos y revisar incidencias | Si | Si | No |
| Exportar Excel | Si | Si | No |
| Cambiar tarifa de una inscripcion existente | Si | No | No |
| Anular pagos o ingresos con motivo | Si | No | No |
| Importar, respaldar, restaurar, configurar y administrar operadores | Si | No | No |

Los permisos se verifican en el proceso principal, no solo ocultando botones.
Las contrasenas se almacenan con scrypt y sal aleatoria; cinco intentos fallidos
activan una espera de un minuto. No hay recuperacion por correo ni usuarios
predeterminados: conservar las credenciales de administracion. Se puede crear
otro administrador antes de desactivar una cuenta; no se permite desactivar
la cuenta que esta operando.

## Persistencia y datos personales

La base de trabajo esta en `%APPDATA%\registro-congreso\congreso.sqlite`; la
ubicacion exacta aparece en Configuracion. Los datos se guardan fuera del
directorio de instalacion y sobreviven al cierre y a las actualizaciones.
Las escrituras relacionadas son transaccionales y cada conexion activa claves
foraneas.

La base **no esta cifrada**. Los roles de la app no impiden que una persona con
acceso al archivo lo abra externamente. Proteger el equipo, su cuenta de Windows
y los respaldos. `data\`, compilados y resultados de pruebas estan excluidos de
Git. El Excel original tambien contiene datos personales: no distribuirlo junto
con el instalador ni publicarlo.

Los respaldos locales no protegen contra la perdida del disco. Crear respaldos
manuales en otro dispositivo. Para restaurar, se valida la integridad y se
requieren los usuarios del respaldo; si se restaura una base inicial de version 1,
se crea un nuevo administrador. Las copias anteriores a la restauracion quedan
en la carpeta `backups` junto a la base de trabajo.

## Modelo de datos y migracion

`database\schema.sql` define la base inicial, version 1:

- `events`, `attendees`, `registrations`.
- `payments`: abonos y acumulados iniciales, con anulaciones justificadas.
- `sessions`, `checkins`: ingreso unico vigente por inscripcion y sesion.
- `import_batches`, `import_issues`: procedencia e incidencias.
- `registration_balances`: pagado, saldo, excedente y estado calculados.

La aplicacion migra transaccionalmente a version 2 agregando `operators`,
`audit_log` y la politica `allow_debt`. La base inicial del repositorio permanece
en version 1 para conservar su uso con los scripts PowerShell.

Todos los importes son centavos enteros. Cada inscripcion conserva su tarifa
individual aunque cambie la tarifa general. Se conserva el nombre completo sin
dividirlo automaticamente ni fusionar iglesias.

La importacion inicial tiene 51 personas, 9000 MXN pagados y 1200 MXN de saldo
calculado con la tarifa confirmada de 200 MXN: 43 liquidados, 4 parciales y 4 sin
pago registrado. Los montos vacios estan pendientes de verificacion.
Los pagos importados son acumulados, no un historial inventado de abonos.
Los telefonos con notas pasan a observaciones, las fechas futuras se conservan
y las marcas de asistencia del Excel requieren revision antes de crear ingresos.
Correo, fechas de pagos y otros campos desconocidos quedan vacios.

## Importar desde Excel en la interfaz

Se admite `.xlsx`, hasta 25 MB, hoja `Inscripciones`, encabezados en fila 7 y
columnas A:N de la plantilla original. No se admiten libros con fechas base
1904 ni formulas sin resultado guardado. No se ejecutan macros ni formulas.
Se rechazan importes negativos, fechas invalidas y datos sin nombre.

Importar exactamente el mismo archivo no duplica datos. En un archivo distinto,
las coincidencias por nombre se muestran para revision y quedan desmarcadas;
incluirlas crea otra persona. Los registros existentes se corrigen desde su
expediente. Las filas excluidas no se importan y el archivo queda registrado
como procesado: revisar toda la seleccion antes de confirmar.

Los reportes exportados tienen una estructura de consulta diferente y no se usan
como plantilla de reimportacion.

## Desarrollo

Requiere Node.js 24 LTS (incluye `node:sqlite`) y npm:

```powershell
npm.cmd ci
npm.cmd run dev
```

La primera vez se usa una base vacia en el perfil local; cargar la base inicial
desde la pantalla de configuracion de administrador. No hay llamadas externas
en tiempo de operacion. El servidor de desarrollo solo escucha en 127.0.0.1.

```powershell
npm.cmd run build
npm.cmd start
npm.cmd test
npm.cmd run test:e2e
npm.cmd run dist
```

`build` verifica TypeScript y genera `dist\`. `dist` crea el instalador NSIS y
`release\win-unpacked\Registro Congreso.exe` (requiere toda esa carpeta).
`test:e2e` abre Electron real con datos temporales, sin modificar la base inicial.

Para validar tambien la aplicacion empaquetada:

```powershell
$env:CONGRESO_EXECUTABLE = (Resolve-Path '.\release\win-unpacked\Registro Congreso.exe').Path
node .\tests\desktop.mjs
Remove-Item Env:\CONGRESO_EXECUTABLE
```

Las pruebas cubren migracion, conciliacion de 51 registros y pagos, busqueda sin
acentos, validacion, permisos, abonos y anulaciones, ingresos unicos, rollback,
Excel, respaldo/restauracion y persistencia tras reiniciar. Las capturas
temporales se guardan en `test-results\`.

`CONGRESO_DATA_DIR` permite una carpeta de datos separada para pruebas. No apuntar
la aplicacion a una carpeta compartida de red.

### Importador inicial PowerShell

Windows 10/11 incluye `winsqlite3.dll`, usado por los scripts originales:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\Import-Workbook.ps1 -Fee 200
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\Test-Database.ps1
```

La politica de ejecucion se aplica solo al proceso, no cambia permanentemente
el equipo. Este importador se limita a crear bases iniciales version 1 y no
mezcla archivos distintos sobre bases ya pobladas. No usarlo para editar la
base activa version 2 de la app.

## Fuera de esta version

Sincronizacion entre computadoras, QR/gafetes, recibos impresos, correo,
actualizaciones automaticas, cifrado de la base y recuperacion de contrasenas.
