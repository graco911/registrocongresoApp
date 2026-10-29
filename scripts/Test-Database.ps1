$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'SQLite.ps1')
$testPath = Join-Path ([IO.Path]::GetTempPath()) ("congress-test-" + [guid]::NewGuid().ToString('N') + '.sqlite')
$invalidPath = Join-Path ([IO.Path]::GetTempPath()) ("congress-invalid-" + [guid]::NewGuid().ToString('N') + '.xlsx')
$invalidDbPath = [IO.Path]::ChangeExtension($invalidPath, '.sqlite')

function Assert-Equal($Actual, $Expected, [string]$Label) {
    if ([string]$Actual -cne [string]$Expected) {
        throw "${Label}: esperado '$Expected', obtenido '$Actual'."
    }
}

function Assert-Rejected([string]$Sql, [string]$Label) {
    $rejected = $false
    try { $null = $db.Execute($Sql) }
    catch {
        if ($_.Exception.Message -notmatch 'constraint failed') { throw }
        $rejected = $true
    }
    if (-not $rejected) { throw "No se rechazo: $Label" }
}

$db = $null
$transaction = $false
try {
    $null = & (Join-Path $PSScriptRoot 'Import-Workbook.ps1') -DatabasePath $testPath -Fee 200
    $db = New-Object CongressSQLite($testPath)
    Assert-Equal $db.Execute('PRAGMA integrity_check;')[0]['integrity_check'] 'ok' 'Integridad'
    Assert-Equal $db.Execute('PRAGMA foreign_key_check;').Count 0 'Referencias'
    Assert-Equal $db.Execute('SELECT count(*) AS n FROM attendees;')[0]['n'] 51 'Congresistas'
    Assert-Equal $db.Execute('SELECT count(*) AS n FROM registrations;')[0]['n'] 51 'Inscripciones'
    Assert-Equal $db.Execute('SELECT count(*) AS n FROM payments;')[0]['n'] 47 'Acumulados pagados'
    Assert-Equal $db.Execute('SELECT sum(paid_cents) AS n FROM registration_balances;')[0]['n'] 900000 'Recaudacion'
    Assert-Equal $db.Execute('SELECT sum(balance_cents) AS n FROM registration_balances;')[0]['n'] 120000 'Adeudos'
    foreach ($pair in @(@('paid',43), @('partial',4), @('pending',4))) {
        Assert-Equal $db.Execute("SELECT count(*) AS n FROM registration_balances WHERE payment_status='$($pair[0])';")[0]['n'] $pair[1] "Estado $($pair[0])"
    }
    Assert-Equal $db.Execute('SELECT count(*) AS n FROM checkins;')[0]['n'] 0 'No inventar asistencia'
    Assert-Equal $db.Execute('SELECT count(*) AS n FROM sessions WHERE session_date IS NULL;')[0]['n'] 2 'Fechas sin inventar'
    Assert-Equal $db.Execute("SELECT count(*) AS n FROM import_issues WHERE code='contact_note';")[0]['n'] 13 'Notas de contacto'
    Assert-Equal $db.Execute("SELECT count(*) AS n FROM import_issues WHERE code='status_mismatch';")[0]['n'] 1 'Estado invalido'
    Assert-Equal $db.Execute('SELECT count(*) AS n FROM attendees WHERE phone IS NOT NULL OR email IS NOT NULL;')[0]['n'] 0 'Contacto no inventado'
    $raw = $db.Execute('SELECT source_data_json FROM registrations WHERE source_row=8;')[0]['source_data_json'] | ConvertFrom-Json
    Assert-Equal $raw.G 'PARA EL DIA 13' 'Origen conservado'
    $unicode = 'Di' + [char]0xE1 + 'cono'
    Assert-Equal $db.Execute("SELECT count(*) AS n FROM attendees WHERE role=$(ConvertTo-SqlText $unicode);")[0]['n'] 2 'UTF-8'
    Assert-Equal $db.Execute("SELECT $(ConvertTo-SqlText "O'Brien") AS value;")[0]['value'] "O'Brien" 'Comillas SQL'

    $null = & (Join-Path $PSScriptRoot 'Import-Workbook.ps1') -DatabasePath $testPath -Fee 200
    Assert-Equal $db.Execute('SELECT count(*) AS n FROM registrations;')[0]['n'] 51 'Reimportacion idempotente'
    Assert-Equal $db.Execute('SELECT count(*) AS n FROM import_batches;')[0]['n'] 1 'Un solo lote'

    $null = $db.Execute('BEGIN;')
    $transaction = $true
    $null = $db.Execute("INSERT INTO checkins(event_id,registration_id,session_id,recorded_by) VALUES(1,1,1,'test');")
    Assert-Rejected "INSERT INTO checkins(event_id,registration_id,session_id,recorded_by) VALUES(1,1,1,'test');" 'Check-in duplicado'
    Assert-Rejected "UPDATE checkins SET voided_at='2026-10-28' WHERE id=1;" 'Anulacion sin motivo'
    $null = $db.Execute("UPDATE checkins SET voided_at='2026-10-28',void_reason='Prueba' WHERE id=1;
        INSERT INTO checkins(event_id,registration_id,session_id,recorded_by) VALUES(1,1,1,'test');
        INSERT INTO checkins(event_id,registration_id,session_id,recorded_by) VALUES(1,1,2,'test');
        INSERT INTO events(id,name,default_fee_cents) VALUES(2,'Otro evento',20000);
        INSERT INTO sessions(id,event_id,name) VALUES(3,2,'Otra sesion');")
    Assert-Rejected "INSERT INTO checkins(event_id,registration_id,session_id,recorded_by) VALUES(1,1,3,'test');" 'Cruce de eventos'
    Assert-Rejected "INSERT INTO payments(registration_id,amount_cents,kind) VALUES(99999,100,'payment');" 'Pago huerfano'
    Assert-Rejected "INSERT INTO payments(registration_id,amount_cents,kind) VALUES(1,-100,'payment');" 'Pago negativo'
    $partialId = $db.Execute("SELECT registration_id AS id FROM registration_balances WHERE payment_status='partial' LIMIT 1;")[0]['id']
    $null = $db.Execute("INSERT INTO payments(registration_id,amount_cents,kind) VALUES($partialId,10000,'payment');")
    $paymentId = $db.Execute('SELECT last_insert_rowid() AS id;')[0]['id']
    Assert-Equal $db.Execute("SELECT payment_status FROM registration_balances WHERE registration_id=$partialId;")[0]['payment_status'] 'paid' 'Liquidacion'
    $null = $db.Execute("UPDATE payments SET voided_at='2026-10-28',void_reason='Prueba' WHERE id=$paymentId;")
    Assert-Equal $db.Execute("SELECT balance_cents FROM registration_balances WHERE registration_id=$partialId;")[0]['balance_cents'] 10000 'Anulacion de pago'
    $null = $db.Execute("INSERT INTO payments(registration_id,amount_cents,kind) VALUES(1,5000,'payment');")
    Assert-Equal $db.Execute('SELECT excess_cents FROM registration_balances WHERE registration_id=1;')[0]['excess_cents'] 5000 'Excedente'
    $null = $db.Execute('ROLLBACK;')
    $transaction = $false
    $db.Dispose()
    $db = New-Object CongressSQLite($testPath)
    Assert-Equal $db.Execute('SELECT sum(amount_cents) AS n FROM payments;')[0]['n'] 900000 'Persistencia'

    Copy-Item -LiteralPath (Join-Path $PSScriptRoot '..\Libro7.xlsx') -Destination $invalidPath
    $zip = [IO.Compression.ZipFile]::Open($invalidPath, [IO.Compression.ZipArchiveMode]::Update)
    try {
        $entry = $zip.GetEntry('xl/worksheets/sheet1.xml')
        $reader = New-Object IO.StreamReader($entry.Open())
        try { [xml]$xml = $reader.ReadToEnd() } finally { $reader.Dispose() }
        ($xml.worksheet.sheetData.row.c | Where-Object { $_.r -eq 'H10' }).v = '-1'
        $entry.Delete()
        $entry = $zip.CreateEntry('xl/worksheets/sheet1.xml')
        $writer = New-Object IO.StreamWriter($entry.Open())
        try { $writer.Write($xml.OuterXml) } finally { $writer.Dispose() }
    } finally { $zip.Dispose() }
    $rejected = $false
    try { $null = & (Join-Path $PSScriptRoot 'Import-Workbook.ps1') -WorkbookPath $invalidPath -DatabasePath $invalidDbPath -Fee 200 }
    catch {
        if ($_.Exception.Message -notmatch 'Importe invalido') { throw }
        $rejected = $true
    }
    Assert-Equal $rejected $true 'Importacion invalida rechazada'
    $invalidDb = New-Object CongressSQLite($invalidDbPath)
    try {
        Assert-Equal $invalidDb.Execute("SELECT count(*) AS n FROM sqlite_master WHERE type='table';")[0]['n'] 0 'Rollback completo'
    } finally { $invalidDb.Dispose() }
    Write-Output 'OK: importacion, conciliacion, UTF-8, persistencia, duplicados, pagos, asistencia y rollback.'
} finally {
    if ($null -ne $db) {
        try { if ($transaction) { $null = $db.Execute('ROLLBACK;') } }
        finally { $db.Dispose() }
    }
    foreach ($file in @($testPath, $invalidPath, $invalidDbPath)) {
        if (Test-Path -LiteralPath $file) { Remove-Item -LiteralPath $file }
    }
}
