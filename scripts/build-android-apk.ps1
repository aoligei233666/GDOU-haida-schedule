param(
    [switch]$CleanPrebuild,
    [string]$Architectures = "arm64-v8a,x86_64"
)

$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$appJson = Get-Content (Join-Path $projectRoot "app.json") -Raw -Encoding UTF8 | ConvertFrom-Json
$appVersion = $appJson.expo.version
if (-not $appVersion) {
    throw "Unable to read expo.version from app.json"
}

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

# 1. Generate or refresh Android native project cleanly via Expo Config Plugin
$androidDir = Join-Path $projectRoot "android"
if ($CleanPrebuild -or -not (Test-Path $androidDir)) {
    Write-Host "Running Expo CNG prebuild for Android (v$appVersion)..." -ForegroundColor Cyan
    Push-Location $projectRoot
    try {
        $env:EXPO_NO_GIT_STATUS = "1"
        cmd /c "npx expo prebuild --platform android --clean --no-install"
        if ($LASTEXITCODE -ne 0) { throw "expo prebuild failed with exit code $LASTEXITCODE" }
    } finally {
        Pop-Location
    }
}

# 2. Configure release signing (external private keystore — never debug.keystore)
$keystorePropsPath = Join-Path $androidDir "keystore.properties"
if (-not $env:GDOU_RELEASE_STORE_FILE) {
    $defaultKs = Join-Path $env:USERPROFILE ".gdou-keystore\haida-schedule-release.jks"
    $defaultPass = Join-Path $env:USERPROFILE ".gdou-keystore\keystore-pass.txt"
    if ((Test-Path $defaultKs) -and (Test-Path $defaultPass)) {
        $env:GDOU_RELEASE_STORE_FILE = $defaultKs
        $env:GDOU_RELEASE_STORE_PASSWORD = (Get-Content $defaultPass -Raw).Trim()
        $env:GDOU_RELEASE_KEY_ALIAS = "haida-schedule-release"
        $env:GDOU_RELEASE_KEY_PASSWORD = $env:GDOU_RELEASE_STORE_PASSWORD
    }
}
$hasEnvSigning = $env:GDOU_RELEASE_STORE_FILE -and $env:GDOU_RELEASE_STORE_PASSWORD -and $env:GDOU_RELEASE_KEY_ALIAS -and $env:GDOU_RELEASE_KEY_PASSWORD
$hasPropsSigning = Test-Path $keystorePropsPath
$requireSigning = $hasEnvSigning -or $hasPropsSigning

if (-not $requireSigning) {
    Write-Warning "No release keystore configured (android/keystore.properties or GDOU_RELEASE_* env vars). Building unsigned release APK."
}

# 3. Build Release APK (select newer SDK CMake >= 3.31 on Windows so Ninja supports long paths natively)
$cmakeVer = $null
$cmakeRoot = Join-Path $env:ANDROID_HOME "cmake"
if (Test-Path $cmakeRoot) {
    $cmakeDir = Get-ChildItem $cmakeRoot -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match '^3\.(3[0-9]|[4-9][0-9])\.' } |
        Sort-Object Name -Descending |
        Select-Object -First 1
    if ($cmakeDir) {
        $cmakeVer = $cmakeDir.Name
        Write-Host "Using Android SDK CMake $cmakeVer (long-path Ninja enabled)" -ForegroundColor DarkGray
    }
}

Push-Location $androidDir
try {
    $gradleArgs = @(
        "assembleRelease",
        "-PreactNativeArchitectures=$Architectures",
        "--console=plain",
        "--no-daemon"
    )
    if ($cmakeVer) {
        $gradleArgs += "-Pandroid.cmakeVersion=$cmakeVer"
    }
    if ($requireSigning) {
        $gradleArgs += "-PrequireReleaseSigning=true"
    }

    & .\gradlew.bat @gradleArgs
    if ($LASTEXITCODE -ne 0) { throw "Gradle assembleRelease failed with exit code $LASTEXITCODE" }

    $distDir = Join-Path $projectRoot "dist"
    New-Item -ItemType Directory -Force -Path $distDir | Out-Null

    if ($requireSigning) {
        $apkSource = Join-Path $androidDir "app\build\outputs\apk\release\app-release.apk"
        $apkOut = Join-Path $distDir "haida-schedule-v$appVersion-android.apk"
    } else {
        $apkSource = Join-Path $androidDir "app\build\outputs\apk\release\app-release-unsigned.apk"
        $apkOut = Join-Path $distDir "haida-schedule-v$appVersion-android-unsigned.apk"
    }

    if (-not (Test-Path $apkSource)) {
        throw "Expected APK artifact not found at $apkSource"
    }

    Copy-Item $apkSource $apkOut -Force
    $sha = (Get-FileHash $apkOut -Algorithm SHA256).Hash
    $size = (Get-Item $apkOut).Length
    Write-Host "`nAPK built successfully: $apkOut" -ForegroundColor Green
    Write-Host "Size: $size bytes | SHA-256: $sha" -ForegroundColor Cyan
} finally {
    Pop-Location
}
