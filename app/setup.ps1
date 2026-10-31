# 설치: Node.js, Google Drive for Desktop, 프로그램 구성 요소를 깔고 설정 화면을 연다
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

function Step($text) { Write-Host "`n== $text ==" -ForegroundColor Green }

function Refresh-Path {
    $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
}

function Install-WithWinget($id, $name) {
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        throw "$name 을(를) 자동으로 설치할 수 없습니다(winget 없음). Microsoft Store에서 '앱 설치 관리자'를 업데이트한 뒤 다시 실행해 주세요."
    }
    Write-Host "$name 설치 중... (몇 분 걸릴 수 있습니다. '이 앱이 디바이스를 변경하도록 허용' 창이 뜨면 '예'를 눌러 주세요)"
    winget install --id $id -e --accept-package-agreements --accept-source-agreements
    Refresh-Path
}

try {
    Step "1/5 Node.js 확인"
    if (Get-Command node -ErrorAction SilentlyContinue) {
        Write-Host "이미 설치되어 있습니다."
    } else {
        Install-WithWinget "OpenJS.NodeJS.LTS" "Node.js"
        if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "Node.js 설치를 확인하지 못했습니다. PC를 다시 켠 뒤 '1_설치'를 한 번 더 실행해 주세요." }
    }

    Step "2/5 Google Drive for Desktop 확인"
    if (Test-Path "$env:ProgramFiles\Google\Drive File Stream") {
        Write-Host "이미 설치되어 있습니다."
    } else {
        Install-WithWinget "Google.GoogleDrive" "Google Drive"
        Write-Host ""
        Write-Host "Google Drive 창이 뜨면 사진이 들어 있는 구글 계정으로 로그인해 주세요." -ForegroundColor Yellow
        Write-Host "로그인하면 내 PC에 'Google Drive (G:)' 드라이브가 생깁니다." -ForegroundColor Yellow
        $launcher = "$env:ProgramFiles\Google\Drive File Stream\launch.bat"
        if (Test-Path $launcher) { Start-Process $launcher }
        Read-Host "구글 드라이브 로그인을 마친 뒤 Enter 키를 눌러 주세요"
    }

    Step "3/5 프로그램 구성 요소 설치"
    npm install --no-fund --no-audit
    if ($LASTEXITCODE -ne 0) { throw "구성 요소 설치에 실패했습니다. 인터넷 연결을 확인하고 다시 실행해 주세요." }

    Step "4/5 바탕 화면 바로가기 만들기"
    # 다음부터는 폴더를 열지 않고 바탕 화면 아이콘으로 켠다. 검은 창은 작업 표시줄로 내려 둔다(WindowStyle 7)
    $programDir = Split-Path $PSScriptRoot -Parent
    $shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path ([Environment]::GetFolderPath("Desktop")) "블로그 글 생성기.lnk"))
    $shortcut.TargetPath = Join-Path $programDir "3_블로그 글 올리기.bat"
    $shortcut.WorkingDirectory = $programDir
    $shortcut.IconLocation = (Join-Path $PSScriptRoot "icon.ico") + ",0"
    $shortcut.WindowStyle = 7
    $shortcut.Description = "사진으로 네이버 블로그 글 만들기"
    $shortcut.Save()
    Write-Host "바탕 화면에 '블로그 글 생성기' 아이콘을 만들었습니다."

    Step "5/5 프로그램 창 열기"
    Write-Host "설치가 끝났습니다. 이어서 프로그램 창이 열립니다. 처음이면 '처음 설정' 안내가 한 단계씩 나옵니다."
    node app.js settings
    Write-Host "`n모두 끝났습니다. 다음부터는 바탕 화면의 '블로그 글 생성기' 아이콘을 더블클릭하면 됩니다." -ForegroundColor Green
} catch {
    Write-Host "`n문제가 생겼습니다: $($_.Exception.Message)" -ForegroundColor Red
}
Read-Host "`nEnter 키를 누르면 창이 닫힙니다"
