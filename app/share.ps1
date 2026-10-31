# 다른 사람에게 줄 zip 만들기: 프로그램 파일만 골라 담고, API 키·말투 예시·개인 예시 파일·설치된 구성 요소(node_modules)는 넣지 않는다.
# 설정, 네이버 로그인, 말투 예시는 원래 이 PC의 %LOCALAPPDATA%\BlogWriter 에 있어서 프로그램 폴더에는 없다.
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$zip = Join-Path ([Environment]::GetFolderPath("Desktop")) "블로그글생성기_나눠주기.zip"
$stage = Join-Path $env:TEMP ("blogwriter-share-" + [guid]::NewGuid())
$dest = Join-Path $stage "블로그글생성기"

try {
    New-Item -ItemType Directory -Force (Join-Path $dest "app") | Out-Null

    # 프로그램 폴더 바로 아래에서는 이 목록에 있는 파일만 담는다 (Claude_API_키.txt, *말투 폴더, 글끝_예시.txt 등은 빠진다)
    $topFiles = @("0_사용방법.html", "1_설치.bat", "2_설정.bat", "3_블로그 글 올리기.bat", "4_다른 사람에게 줄 파일 만들기.bat")
    foreach ($name in $topFiles) {
        $src = Join-Path $root $name
        if (Test-Path -LiteralPath $src) { Copy-Item -LiteralPath $src -Destination $dest }
    }
    # app 폴더는 프로그램 코드만. node_modules는 받는 PC에서 1_설치가 새로 깐다
    Get-ChildItem -LiteralPath (Join-Path $root "app") -File |
        Where-Object { $_.Extension -in ".js", ".html", ".json", ".ps1", ".ico" } |
        Copy-Item -Destination (Join-Path $dest "app")

    # 혹시라도 API 키가 섞여 들어갔으면 만들지 않는다
    $leak = Get-ChildItem -LiteralPath $dest -Recurse -File | Select-String -Pattern "sk-ant-[A-Za-z0-9_-]{20,}" -List
    if ($leak) { throw "API 키로 보이는 글자가 들어 있는 파일이 있어서 멈췄습니다: $($leak.Path -join ', ')" }

    if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
    Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
    # 한글 파일 이름이 다른 PC에서도 깨지지 않게 UTF-8로, 폴더 구분은 어느 압축 프로그램이든 읽는 '/'로 담는다
    $archive = [IO.Compression.ZipFile]::Open($zip, [IO.Compression.ZipArchiveMode]::Create, [Text.Encoding]::UTF8)
    try {
        Get-ChildItem -LiteralPath $dest -Recurse -File | ForEach-Object {
            $entry = $_.FullName.Substring($stage.Length + 1).Replace("\", "/")
            [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $_.FullName, $entry, [IO.Compression.CompressionLevel]::Optimal) | Out-Null
        }
    } finally {
        $archive.Dispose()
    }

    Write-Host ""
    Write-Host "다 만들었습니다: $zip" -ForegroundColor Green
    Write-Host ""
    Write-Host "이 zip에는 프로그램만 들어 있고, 내 API 키, 내 설정, 네이버 로그인, 말투 예시는 들어 있지 않습니다."
    Write-Host "받은 사람은 압축을 풀고 '0_사용방법'을 보면서 자기 API 키와 블로그 아이디를 넣으면 됩니다."
    Start-Process explorer.exe "/select,`"$zip`""
} catch {
    Write-Host "`n문제가 생겼습니다: $($_.Exception.Message)" -ForegroundColor Red
} finally {
    if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
}
Read-Host "`nEnter 키를 누르면 창이 닫힙니다"
