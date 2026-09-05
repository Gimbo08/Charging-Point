$ErrorActionPreference = 'Stop'
$gcloud = 'C:\Users\Computer\AppData\Local\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd'
$project = 'charging-point-b58f4'
$secret = 'ocpp-password'
$tempFile = Join-Path $env:TEMP ("ocpp-password-" + [guid]::NewGuid().ToString('N') + '.txt')

if (-not (Test-Path $gcloud)) { throw "gcloud non trovato: $gcloud" }

$secure = Read-Host 'Inserisci la password OCPP impostata sulla wallbox' -AsSecureString
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
    $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
    if ([string]::IsNullOrEmpty($plain)) { throw 'La password non puo essere vuota.' }
    [IO.File]::WriteAllText($tempFile, $plain, [Text.UTF8Encoding]::new($false))
    & $gcloud secrets versions add $secret --data-file=$tempFile --project $project
    if ($LASTEXITCODE -ne 0) { throw "gcloud ha restituito il codice $LASTEXITCODE" }
    Write-Output 'Secret OCPP caricato correttamente.'
} finally {
    if ($ptr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
    if (Test-Path $tempFile) { Remove-Item $tempFile -Force -ErrorAction SilentlyContinue }
    Remove-Variable plain,secure -ErrorAction SilentlyContinue
}
