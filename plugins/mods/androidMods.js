const fs = require('fs');
const path = require('path');
const {
  withAndroidManifest,
  withAppBuildGradle,
  withDangerousMod,
  withGradleProperties,
  withMainApplication,
} = require('@expo/config-plugins');

const NATIVE_ANDROID_DIR = path.join(__dirname, '..', 'native', 'android');

const REMOVED_ANDROID_PERMISSIONS = new Set([
  'android.permission.SYSTEM_ALERT_WINDOW',
  'android.permission.READ_EXTERNAL_STORAGE',
  'android.permission.WRITE_EXTERNAL_STORAGE',
]);

function readAndroidNative(relPath) {
  return fs.readFileSync(path.join(NATIVE_ANDROID_DIR, relPath), 'utf8');
}

function withGdouAndroidManifest(config) {
  return withAndroidManifest(config, (mod) => {
    const manifest = mod.modResults.manifest;

    // 1. Strip unused / overbroad permissions unless marked tools:node="remove"
    if (Array.isArray(manifest['uses-permission'])) {
      manifest['uses-permission'] = manifest['uses-permission'].filter((perm) => {
        const name = perm?.$?.['android:name'];
        const isRemoval = perm?.$?.['tools:node'] === 'remove';
        if (isRemoval) return true;
        return !REMOVED_ANDROID_PERMISSIONS.has(name);
      });
    }

    // 2. Enforce allowBackup="false" & usesCleartextTraffic="false", register Today Widget,
    //    4x4 Weekly Widget, Background Refresh Receiver, and zero-permission SAF Picker Activity
    const app = manifest.application?.[0];
    if (app && app.$) {
      app.$['android:allowBackup'] = 'false';
      app.$['android:usesCleartextTraffic'] = 'false';
    }
    if (app) {
      if (!Array.isArray(app.receiver)) app.receiver = [];

      const ensureReceiver = (name, def) => {
        if (!app.receiver.some((r) => r?.$?.['android:name'] === name)) {
          app.receiver.push(def);
        }
      };

      ensureReceiver('.GdouScheduleWidgetProvider', {
        $: {
          'android:name': '.GdouScheduleWidgetProvider',
          'android:exported': 'true',
          'android:label': '海大课表 · 今日课程',
        },
        'intent-filter': [
          {
            action: [{ $: { 'android:name': 'android.appwidget.action.APPWIDGET_UPDATE' } }],
          },
        ],
        'meta-data': [
          {
            $: {
              'android:name': 'android.appwidget.provider',
              'android:resource': '@xml/gdou_widget_info',
            },
          },
        ],
      });

      ensureReceiver('.GdouWeeklyWidgetProvider', {
        $: {
          'android:name': '.GdouWeeklyWidgetProvider',
          'android:exported': 'true',
          'android:label': '海大课表 · 一周滚动课表',
        },
        'intent-filter': [
          {
            action: [{ $: { 'android:name': 'android.appwidget.action.APPWIDGET_UPDATE' } }],
          },
        ],
        'meta-data': [
          {
            $: {
              'android:name': 'android.appwidget.provider',
              'android:resource': '@xml/gdou_widget_weekly_info',
            },
          },
        ],
      });

      ensureReceiver('.GdouWidgetRefreshReceiver', {
        $: {
          'android:name': '.GdouWidgetRefreshReceiver',
          'android:exported': 'false',
        },
        'intent-filter': [
          {
            action: [
              { $: { 'android:name': 'android.intent.action.BOOT_COMPLETED' } },
              { $: { 'android:name': 'android.intent.action.DATE_CHANGED' } },
              { $: { 'android:name': 'android.intent.action.TIME_SET' } },
              { $: { 'android:name': 'android.intent.action.TIMEZONE_CHANGED' } },
              { $: { 'android:name': 'cn.edu.gdou.schedule.ACTION_REFRESH_WIDGETS' } },
            ],
          },
        ],
      });

      if (!Array.isArray(app.activity)) app.activity = [];
      if (!app.activity.some((a) => a?.$?.['android:name'] === '.GdouMediaPickerActivity')) {
        app.activity.push({
          $: {
            'android:name': '.GdouMediaPickerActivity',
            'android:exported': 'false',
            'android:theme': '@android:style/Theme.Translucent.NoTitleBar',
          },
        });
      }
    }

    // 3. Ensure <queries> declares SET_ALARM and SHOW_ALARMS for Android 11+ system clock alarm
    if (!Array.isArray(manifest.queries)) {
      manifest.queries = [{}];
    }
    const queriesNode = manifest.queries[0];
    if (!Array.isArray(queriesNode.intent)) {
      queriesNode.intent = [];
    }
    for (const alarmAction of [
      'android.intent.action.SET_ALARM',
      'android.intent.action.SHOW_ALARMS',
    ]) {
      const hasAction = queriesNode.intent.some(
        (intent) =>
          Array.isArray(intent.action) &&
          intent.action.some((a) => a?.$?.['android:name'] === alarmAction)
      );
      if (!hasAction) {
        queriesNode.intent.push({
          action: [{ $: { 'android:name': alarmAction } }],
        });
      }
    }

    return mod;
  });
}

function withGdouMainApplication(config) {
  return withMainApplication(config, (mod) => {
    mod.modResults.contents = readAndroidNative('MainApplication.kt');
    return mod;
  });
}

function withGdouGradleProperties(config) {
  return withGradleProperties(config, (mod) => {
    const desired = {
      'android.enableMinifyInReleaseBuilds': 'true',
      'android.enableShrinkResourcesInReleaseBuilds': 'true',
      'EX_DEV_CLIENT_NETWORK_INSPECTOR': 'false',
      'expo.useLegacyPackaging': 'true',
    };
    for (const [key, value] of Object.entries(desired)) {
      const existing = mod.modResults.find((item) => item.type === 'property' && item.key === key);
      if (existing) {
        existing.value = value;
      } else {
        mod.modResults.push({ type: 'property', key, value });
      }
    }
    return mod;
  });
}

function withGdouAppBuildGradle(config) {
  return withAppBuildGradle(config, (mod) => {
    let contents = mod.modResults.contents;
    const versionName = config.version || '2.0.0';
    const versionCode = Number(config.android?.versionCode) || 13;

    contents = contents.replace(/versionCode\s+\d+/, `versionCode ${versionCode}`);
    contents = contents.replace(/versionName\s+["'][^"']+["']/, `versionName "${versionName}"`);

    const signingHelperMarker = '// GDOU_RELEASE_SIGNING_CONFIG';
    if (!contents.includes(signingHelperMarker)) {
      const helperBlock = `
${signingHelperMarker}
def gdouKeystoreProps = new Properties()
def gdouKeystorePropsFile = rootProject.file("keystore.properties")
if (gdouKeystorePropsFile.exists()) {
    gdouKeystorePropsFile.withInputStream { gdouKeystoreProps.load(it) }
}
def gdouStoreFile = System.getenv("GDOU_RELEASE_STORE_FILE") ?: gdouKeystoreProps.getProperty("storeFile")
def gdouStorePassword = System.getenv("GDOU_RELEASE_STORE_PASSWORD") ?: gdouKeystoreProps.getProperty("storePassword")
def gdouKeyAlias = System.getenv("GDOU_RELEASE_KEY_ALIAS") ?: gdouKeystoreProps.getProperty("keyAlias")
def gdouKeyPassword = System.getenv("GDOU_RELEASE_KEY_PASSWORD") ?: gdouKeystoreProps.getProperty("keyPassword")
def hasGdouReleaseSigning = gdouStoreFile && gdouStorePassword && gdouKeyAlias && gdouKeyPassword && file(gdouStoreFile).exists()
`;
      contents = contents.replace(/^android\s*\{/m, `${helperBlock}\nandroid {`);
    }

    if (!contents.includes('if (hasGdouReleaseSigning)')) {
      contents = contents.replace(
        /signingConfigs\s*\{\s*debug\s*\{[\s\S]*?\}\s*\}/m,
        (match) => {
          const closingIdx = match.lastIndexOf('}');
          const releaseSigning = `
        release {
            if (hasGdouReleaseSigning) {
                storeFile file(gdouStoreFile)
                storePassword gdouStorePassword
                keyAlias gdouKeyAlias
                keyPassword gdouKeyPassword
            }
        }
    `;
          return match.slice(0, closingIdx) + releaseSigning + '}';
        }
      );
    }

    contents = contents.replace(
      /(buildTypes\s*\{[\s\S]*?release\s*\{[\s\S]*?)signingConfig\s+signingConfigs\.debug/,
      `$1if (hasGdouReleaseSigning) {\n                signingConfig signingConfigs.release\n            } else if ((findProperty('requireReleaseSigning') ?: 'false').toBoolean()) {\n                throw new GradleException("Release signing keystore is required. Configure android/keystore.properties or GDOU_RELEASE_* env vars.")\n            }`
    );

    if (!contents.includes("testImplementation 'junit:junit:")) {
      contents = contents.replace(
        /^dependencies\s*\{/m,
        `dependencies {\n    testImplementation 'junit:junit:4.13.2'`
      );
    }

    mod.modResults.contents = contents;
    return mod;
  });
}

function withGdouAndroidNativeFiles(config) {
  return withDangerousMod(config, [
    'android',
    async (mod) => {
      const androidRoot = mod.modRequest.platformProjectRoot;
      fs.writeFileSync(
        path.join(androidRoot, 'app', 'proguard-rules.pro'),
        readAndroidNative('proguard-rules.pro'),
        'utf8'
      );

      const pkgDir = path.join(androidRoot, 'app', 'src', 'main', 'java', 'cn', 'edu', 'gdou', 'schedule');
      fs.mkdirSync(pkgDir, { recursive: true });
      for (const ktFile of [
        'GdouScheduleWidgetProvider.kt',
        'GdouWeeklyWidgetProvider.kt',
        'GdouWidgetRefreshReceiver.kt',
        'GdouMediaPickerActivity.kt',
      ]) {
        fs.writeFileSync(path.join(pkgDir, ktFile), readAndroidNative(ktFile), 'utf8');
      }

      const testPkgDir = path.join(androidRoot, 'app', 'src', 'test', 'java', 'cn', 'edu', 'gdou', 'schedule');
      fs.mkdirSync(testPkgDir, { recursive: true });
      fs.writeFileSync(
        path.join(testPkgDir, 'GdouEphemeralCookieJarTest.kt'),
        readAndroidNative(path.join('test', 'GdouEphemeralCookieJarTest.kt')),
        'utf8'
      );

      const resDir = path.join(androidRoot, 'app', 'src', 'main', 'res');
      fs.mkdirSync(path.join(resDir, 'drawable'), { recursive: true });
      fs.mkdirSync(path.join(resDir, 'layout'), { recursive: true });
      fs.mkdirSync(path.join(resDir, 'xml'), { recursive: true });
      fs.writeFileSync(
        path.join(resDir, 'drawable', 'gdou_widget_bg.xml'),
        readAndroidNative(path.join('res', 'drawable', 'gdou_widget_bg.xml')),
        'utf8'
      );
      fs.writeFileSync(
        path.join(resDir, 'layout', 'gdou_widget_schedule.xml'),
        readAndroidNative(path.join('res', 'layout', 'gdou_widget_schedule.xml')),
        'utf8'
      );
      fs.writeFileSync(
        path.join(resDir, 'layout', 'gdou_widget_weekly.xml'),
        readAndroidNative(path.join('res', 'layout', 'gdou_widget_weekly.xml')),
        'utf8'
      );
      fs.writeFileSync(
        path.join(resDir, 'xml', 'gdou_widget_info.xml'),
        readAndroidNative(path.join('res', 'xml', 'gdou_widget_info.xml')),
        'utf8'
      );
      fs.writeFileSync(
        path.join(resDir, 'xml', 'gdou_widget_weekly_info.xml'),
        readAndroidNative(path.join('res', 'xml', 'gdou_widget_weekly_info.xml')),
        'utf8'
      );

      return mod;
    },
  ]);
}

function applyGdouAndroidMods(config) {
  config = withGdouAndroidManifest(config);
  config = withGdouMainApplication(config);
  config = withGdouGradleProperties(config);
  config = withGdouAppBuildGradle(config);
  config = withGdouAndroidNativeFiles(config);
  return config;
}

module.exports = { applyGdouAndroidMods };
