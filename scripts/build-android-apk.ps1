$ErrorActionPreference = "Stop"

if (-not $env:JAVA_HOME) {
    $jdkBase = "$env:LOCALAPPDATA\gdou-jdk17"
    $jdkDir = Get-ChildItem $jdkBase -Directory -Filter "jdk-*" -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($jdkDir) {
        $env:JAVA_HOME = $jdkDir.FullName
    }
}
if (-not $env:JAVA_HOME) {
    throw "JAVA_HOME is not set. Please install JDK 17/21 and set JAVA_HOME."
}

if (-not $env:ANDROID_HOME) {
    $env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
}
$env:ANDROID_SDK_ROOT = $env:ANDROID_HOME
$env:PATH = "$env:JAVA_HOME\bin;$env:ANDROID_HOME\cmdline-tools\latest\bin;$env:ANDROID_HOME\platform-tools;$env:PATH"

$projectRoot = Split-Path -Parent $PSScriptRoot
Push-Location "$projectRoot\android"
try {
    & .\gradlew.bat assembleRelease "-PreactNativeArchitectures=arm64-v8a,x86_64" --console=plain --no-daemon
    $apkSource = "$projectRoot\android\app\build\outputs\apk\release\app-release.apk"
    $distDir = "$projectRoot\dist"
    New-Item -ItemType Directory -Force -Path $distDir | Out-Null
    $apkOut1 = "$distDir\gdou-schedule-v1.0.0-android.apk"
    $apkOut2 = "$distDir\haida-schedule-v1.1.0-android.apk"
    Copy-Item $apkSource $apkOut1 -Force
    Copy-Item $apkSource $apkOut2 -Force
    Write-Host "`nAPK built successfully: $apkOut2" -ForegroundColor Green
} finally {
    Pop-Location
}
