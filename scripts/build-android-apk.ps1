$ErrorActionPreference = "Stop"

$jdkBase = "$env:LOCALAPPDATA\gdou-jdk17"
$jdkDir = Get-ChildItem $jdkBase -Directory -Filter "jdk-*" -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $jdkDir) {
    throw "JDK 17 not found under $jdkBase. Set JAVA_HOME manually or install JDK 17."
}

$env:JAVA_HOME = $jdkDir.FullName
$env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
$env:ANDROID_SDK_ROOT = $env:ANDROID_HOME
$env:PATH = "$env:JAVA_HOME\bin;$env:ANDROID_HOME\cmdline-tools\latest\bin;$env:ANDROID_HOME\platform-tools;$env:PATH"

$projectRoot = Split-Path -Parent $PSScriptRoot
Push-Location "$projectRoot\android"
try {
    & .\gradlew.bat assembleRelease "-PreactNativeArchitectures=arm64-v8a" --console=plain --no-daemon
    $apkSource = "$projectRoot\android\app\build\outputs\apk\release\app-release.apk"
    $distDir = "$projectRoot\dist"
    New-Item -ItemType Directory -Force -Path $distDir | Out-Null
    $apkOut = "$distDir\gdou-schedule-v1.0.0-android.apk"
    Copy-Item $apkSource $apkOut -Force
    Write-Host "`nAPK built successfully: $apkOut" -ForegroundColor Green
} finally {
    Pop-Location
}
