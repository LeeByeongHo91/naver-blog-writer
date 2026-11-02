# 윈도우 기본 음성으로 글을 wav로 만든다. 입력: UTF-8 JSON [{ "text": "...", "out": "C:\\...\\1.wav" }]
param([string]$Jobs, [int]$Rate = 1)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Speech
$list = Get-Content -LiteralPath $Jobs -Raw -Encoding UTF8 | ConvertFrom-Json
$voice = New-Object System.Speech.Synthesis.SpeechSynthesizer
$korean = $voice.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.Name -eq "ko-KR" } | Select-Object -First 1
if (-not $korean) { throw "NO_KOREAN_VOICE" }
$voice.SelectVoice($korean.VoiceInfo.Name)
$voice.Rate = $Rate
foreach ($job in $list) {
    $voice.SetOutputToWaveFile($job.out)
    $voice.Speak($job.text)
    $voice.SetOutputToNull()
}
$voice.Dispose()
"ok"
