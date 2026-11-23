param(
    [string]$Path = (Join-Path $PSScriptRoot '..\tests\fixtures\english.wav'),
    [string]$Text = 'The quick brown fox jumps over the lazy dog.'
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
$voice = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
    $voice.SetOutputToWaveFile($Path, $format)
    $voice.Speak($Text)
} finally {
    $voice.Dispose()
}
Write-Output "Created $Path"
