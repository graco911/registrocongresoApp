param(
    [string]$WorkbookPath = (Join-Path $PSScriptRoot '..\Libro7.xlsx'),
    [string]$DatabasePath = (Join-Path $PSScriptRoot '..\data\congreso.sqlite'),
    [decimal]$Fee = 200
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'SQLite.ps1')
Add-Type -AssemblyName System.IO.Compression.FileSystem
$culture = [Globalization.CultureInfo]::InvariantCulture

function ConvertTo-Cents([string]$Value) {
    $number = [decimal]::Parse($Value, $culture)
    if ($number -lt 0 -or $number * 100 -ne [decimal]::Truncate($number * 100)) {
        throw "Importe invalido: $Value. Se requieren montos positivos con hasta dos decimales."
    }
    return [long]($number * 100)
}

function Read-ZipXml($Zip, [string]$Name) {
    $entry = $Zip.GetEntry($Name)
    if ($null -eq $entry) { throw "Falta la entrada Excel: $Name" }
    $reader = New-Object IO.StreamReader($entry.Open())
    try { return [xml]$reader.ReadToEnd() } finally { $reader.Dispose() }
}

$feeCents = ConvertTo-Cents $Fee.ToString($culture)
$WorkbookPath = (Resolve-Path -LiteralPath $WorkbookPath).Path
$hash = (Get-FileHash -LiteralPath $WorkbookPath -Algorithm SHA256).Hash
$zip = [IO.Compression.ZipFile]::OpenRead($WorkbookPath)
try {
    $workbook = Read-ZipXml $zip 'xl/workbook.xml'
    if ($workbook.workbook.workbookPr.date1904 -in @('1', 'true')) {
        throw 'El importador inicial no admite fechas Excel con base 1904.'
    }
    $sheetInfo = @($workbook.workbook.sheets.sheet | Where-Object { $_.name -eq 'Inscripciones' })
    if ($sheetInfo.Count -ne 1) { throw 'Se requiere la hoja Inscripciones.' }
    $rels = Read-ZipXml $zip 'xl/_rels/workbook.xml.rels'
    $relationId = $sheetInfo[0].GetAttribute('id', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships')
    $relation = $rels.Relationships.Relationship | Where-Object { $_.Id -eq $relationId }
    $sheetPath = 'xl/' + $relation.Target
    $sheet = Read-ZipXml $zip $sheetPath
    $stringsXml = Read-ZipXml $zip 'xl/sharedStrings.xml'
    $strings = @($stringsXml.sst.si | ForEach-Object { $_.InnerText })
    $rows = @()
    foreach ($row in $sheet.worksheet.sheetData.row) {
        if ([int]$row.r -lt 7) { continue }
        $cells = @{}
        foreach ($cell in $row.c) {
            $value = [string]$cell.v
            if ($cell.t -eq 's' -and $value -ne '') { $value = $strings[[int]$value] }
            if ($cell.t -eq 'inlineStr') { $value = $cell.is.InnerText }
            $cells[($cell.r -replace '\d', '')] = $value
        }
        if ([int]$row.r -eq 7) {
            if ($cells.C -ne 'Nombre completo' -or $cells.D -notlike 'Iglesia*' -or $cells.H -notlike 'Monto*') {
                throw 'Las columnas no coinciden con la plantilla de Libro7.'
            }
        } elseif (-not [string]::IsNullOrWhiteSpace($cells.C)) {
            $rows += [pscustomobject]@{ Number = [int]$row.r; Cells = $cells }
        } elseif (@('B','D','E','F','G','H','K','L','M','N') | Where-Object {
            -not [string]::IsNullOrWhiteSpace($cells[$_])
        }) {
            throw "Fila $($row.r): hay datos sin nombre; revise el Excel antes de importar."
        }
    }
} finally { $zip.Dispose() }
if ($rows.Count -eq 0) { throw 'El archivo no contiene congresistas.' }

$DatabasePath = [IO.Path]::GetFullPath($DatabasePath)
$null = [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($DatabasePath))
$db = New-Object CongressSQLite($DatabasePath)
$transaction = $false
try {
    $null = $db.Execute('BEGIN IMMEDIATE;')
    $transaction = $true
    $version = $db.Execute('PRAGMA user_version;')[0]['user_version']
    if ($version -eq '0') {
        $null = $db.Execute((Get-Content (Join-Path $PSScriptRoot '..\database\schema.sql') -Raw))
    } elseif ($version -ne '1') { throw "Version de base no soportada: $version" }

    $existing = $db.Execute("SELECT id FROM import_batches WHERE event_id=1 AND sha256=$(ConvertTo-SqlText $hash);")
    if ($existing.Count -gt 0) {
        $null = $db.Execute('ROLLBACK;')
        $transaction = $false
        Write-Output 'El archivo ya fue importado. No se modificaron los datos.'
        return
    }
    if ($db.Execute('SELECT id FROM registrations LIMIT 1;').Count -gt 0) {
        throw 'La base ya contiene inscripciones. Este importador inicial no mezcla archivos diferentes; se requiere revision de coincidencias.'
    }
    $null = $db.Execute("INSERT INTO events(id,name,default_fee_cents) VALUES(1,'Congreso',$feeCents);
        INSERT INTO sessions(event_id,name) VALUES(1,'Viernes 13'),(1,'Sabado 14');
        INSERT INTO import_batches(event_id,filename,sha256,sheet_name)
        VALUES(1,$(ConvertTo-SqlText ([IO.Path]::GetFileName($WorkbookPath))),$(ConvertTo-SqlText $hash),'Inscripciones');")
    $batchId = $db.Execute('SELECT last_insert_rowid() AS id;')[0]['id']
    $totalCents = 0L
    $issueCount = 0
    $index = 0
    foreach ($row in $rows) {
        $index++
        $c = $row.Cells
        $issues = @()
        $notes = @()
        $phone = $null
        if (-not [string]::IsNullOrWhiteSpace($c.G)) {
            $digits = $c.G -replace '\D', ''
            if ($c.G -match '^[+\d\s().-]+$' -and $digits.Length -ge 7 -and $digits.Length -le 15) {
                $phone = $c.G.Trim()
            } else {
                $notes += $c.G
                $issues += ,@('phone', 'contact_note', 'El campo telefono contiene texto; se conservo en observaciones.')
            }
        }
        $date = $null
        if (-not [string]::IsNullOrWhiteSpace($c.B)) {
            $dateValue = [datetime]::FromOADate([double]::Parse($c.B, $culture))
            $date = $dateValue.ToString('yyyy-MM-dd', $culture)
            if ($dateValue.Date -gt [datetime]::Today) {
                $issues += ,@('registration_date', 'future_date', 'Fecha futura conservada sin corregir; requiere revision.')
            }
        }
        $paid = 0L
        if (-not [string]::IsNullOrWhiteSpace($c.H)) { $paid = ConvertTo-Cents $c.H }
        else { $issues += ,@('payment', 'missing_amount', 'Monto vacio: no se creo un pago; confirmar si existe adeudo.') }
        $expected = if ($paid -ge $feeCents) { 'Pagado' } elseif ($paid -gt 0) { 'Parcial' } else { 'Pendiente' }
        if ($c.J -ne $expected) {
            $issues += ,@('payment_status', 'status_mismatch', 'Estado original distinto del calculado; se conserva en los datos de origen.')
        }
        foreach ($column in @('M','N')) {
            if (-not [string]::IsNullOrWhiteSpace($c[$column])) {
                $issues += ,@('attendance', 'attendance_review', 'Marca de asistencia original conservada; confirmar sesion antes de crear ingreso.')
            }
        }
        $json = ConvertTo-Json -InputObject $c -Compress
        $folio = 'C-{0:D4}' -f $index
        $null = $db.Execute("INSERT INTO attendees(full_name,phone,church,role,city)
            VALUES($(ConvertTo-SqlText $c.C.Trim()),$(ConvertTo-SqlText $phone),$(ConvertTo-SqlText $c.D),
                   $(ConvertTo-SqlText $c.E),$(ConvertTo-SqlText $c.F));")
        $attendeeId = $db.Execute('SELECT last_insert_rowid() AS id;')[0]['id']
        $null = $db.Execute("INSERT INTO registrations(event_id,attendee_id,folio,registration_date,registered_by,
            fee_cents,notes,import_batch_id,source_row,source_data_json)
            VALUES(1,$attendeeId,'$folio',$(ConvertTo-SqlText $date),$(ConvertTo-SqlText $c.L),
            $feeCents,$(ConvertTo-SqlText ($notes -join '; ')),$batchId,$($row.Number),$(ConvertTo-SqlText $json));")
        $registrationId = $db.Execute('SELECT last_insert_rowid() AS id;')[0]['id']
        if ($paid -gt 0) {
            $null = $db.Execute("INSERT INTO payments(registration_id,amount_cents,kind,method,notes)
                VALUES($registrationId,$paid,'opening_balance',$(ConvertTo-SqlText $c.K),
                'Acumulado importado de Excel; fecha y desglose de abonos desconocidos.');")
        }
        foreach ($issue in $issues) {
            $null = $db.Execute("INSERT INTO import_issues(registration_id,field,code,message)
                VALUES($registrationId,$(ConvertTo-SqlText $issue[0]),$(ConvertTo-SqlText $issue[1]),$(ConvertTo-SqlText $issue[2]));")
            $issueCount++
        }
        $totalCents += $paid
    }
    $null = $db.Execute('COMMIT;')
    $transaction = $false
    [pscustomobject]@{
        Database = $DatabasePath
        Registrations = $rows.Count
        Paid = $totalCents / 100
        Fee = $Fee
        Issues = $issueCount
    }
} finally {
    try { if ($transaction) { $null = $db.Execute('ROLLBACK;') } }
    finally { $db.Dispose() }
}
