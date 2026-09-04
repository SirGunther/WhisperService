$ErrorActionPreference = 'Stop'
$fixturePath = Join-Path $PSScriptRoot '..\tests\fixtures\english.wav'
Add-Type -AssemblyName System.Speech
$format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
$voice = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
    $voice.SetOutputToWaveFile($fixturePath, $format)
    $voice.Speak('The quick brown fox jumps over the lazy dog.')
} finally {
    $voice.Dispose()
}
Write-Output "Created $fixturePath"
