const fs = require('fs');
const path = require('path');
const {
  IOSConfig,
  withAppDelegate,
  withDangerousMod,
  withEntitlementsPlist,
  withInfoPlist,
  withPodfileProperties,
  withXcodeProject,
} = require('@expo/config-plugins');

const NATIVE_IOS_DIR = path.join(__dirname, '..', 'native', 'ios');

function readIosNative(relPath) {
  return fs.readFileSync(path.join(NATIVE_IOS_DIR, relPath), 'utf8');
}

function withGdouIosInfoPlist(config) {
  return withInfoPlist(config, (mod) => {
    const bundleId = config.ios?.bundleIdentifier || 'cn.edu.gdou.schedule';
    mod.modResults.CFBundleShortVersionString = config.version || '2.0.0';
    mod.modResults.CFBundleVersion = String(config.ios?.buildNumber || '13');
    mod.modResults.NSSupportsLiveActivities = true;
    if (!mod.modResults.NSAlarmKitUsageDescription) {
      mod.modResults.NSAlarmKitUsageDescription =
        '用于在 iOS 系统中直接写入海大课表每日早起、课前及考前系统级闹钟（支持锁屏全屏响铃与穿透静音/专注模式）';
    }
    mod.modResults.NSAppTransportSecurity = {
      NSAllowsArbitraryLoads: false,
      NSAllowsLocalNetworking: true,
    };

    const bgModes = Array.isArray(mod.modResults.UIBackgroundModes)
      ? mod.modResults.UIBackgroundModes
      : [];
    if (!bgModes.includes('fetch')) {
      mod.modResults.UIBackgroundModes = [...bgModes, 'fetch'];
    }

    const bgIds = Array.isArray(mod.modResults.BGTaskSchedulerPermittedIdentifiers)
      ? mod.modResults.BGTaskSchedulerPermittedIdentifiers
      : [];
    const widgetRefreshId = `${bundleId}.widget-refresh`;
    if (!bgIds.includes(widgetRefreshId)) {
      mod.modResults.BGTaskSchedulerPermittedIdentifiers = [...bgIds, widgetRefreshId];
    }

    return mod;
  });
}

function withGdouIosEntitlements(config) {
  return withEntitlementsPlist(config, (mod) => {
    const bundleId = config.ios?.bundleIdentifier || 'cn.edu.gdou.schedule';
    const appGroupId = `group.${bundleId}`;
    const existing = Array.isArray(mod.modResults['com.apple.security.application-groups'])
      ? mod.modResults['com.apple.security.application-groups']
      : [];
    if (!existing.includes(appGroupId)) {
      mod.modResults['com.apple.security.application-groups'] = [...existing, appGroupId];
    }
    return mod;
  });
}

function withGdouIosPodfileProperties(config) {
  return withPodfileProperties(config, (mod) => {
    mod.modResults.EX_DEV_CLIENT_NETWORK_INSPECTOR = 'false';
    return mod;
  });
}

function withGdouIosAppDelegate(config) {
  return withAppDelegate(config, (mod) => {
    let contents = mod.modResults.contents;
    if (!contents.includes('GdouEphemeralNetworking.install()')) {
      const target = 'let delegate = ReactNativeDelegate()';
      if (contents.includes(target)) {
        contents = contents.replace(
          target,
          `GdouEphemeralNetworking.install()\n    ${target}`
        );
      } else {
        contents = contents.replace(
          /(didFinishLaunchingWithOptions[\s\S]*?->\s*Bool\s*\{)/,
          `$1\n    GdouEphemeralNetworking.install()`
        );
      }
    }

    const dist = (process.env.EXPO_PUBLIC_APP_DISTRIBUTION || 'sideload').toLowerCase();
    const isAppleOfficialStore = dist === 'testflight' || dist === 'appstore';
    if (!isAppleOfficialStore) {
      if (
        contents.includes('reactNativeFactory = factory') &&
        !contents.includes('GdouOtaBundle.registerFactory(factory)')
      ) {
        contents = contents.replace(
          'reactNativeFactory = factory',
          'reactNativeFactory = factory\n    GdouOtaBundle.registerFactory(factory)'
        );
      }
      const defaultBundleExpr = 'return Bundle.main.url(forResource: "main", withExtension: "jsbundle")';
      if (
        contents.includes(defaultBundleExpr) &&
        !contents.includes('GdouOtaBundle.resolveBundleURL()')
      ) {
        contents = contents.replace(
          defaultBundleExpr,
          'return GdouOtaBundle.resolveBundleURL() ?? Bundle.main.url(forResource: "main", withExtension: "jsbundle")'
        );
      }
    }

    mod.modResults.contents = contents;
    return mod;
  });
}

function withGdouIosNativeFiles(config) {
  return withDangerousMod(config, [
    'ios',
    async (mod) => {
      const iosRoot = mod.modRequest.platformProjectRoot;
      const projectName = mod.modRequest.projectName;
      const appDir = path.join(iosRoot, projectName);
      const bundleId = config.ios?.bundleIdentifier || 'cn.edu.gdou.schedule';
      const appGroupId = `group.${bundleId}`;
      const version = config.version || '2.0.0';
      const buildNumber = String(config.ios?.buildNumber || '13');

      // 1. Write main app target native Swift files (zero-retention networking, ActivityAttributes, Siri/Shortcuts AppIntents)
      fs.writeFileSync(
        path.join(appDir, 'GdouEphemeralNetworking.swift'),
        readIosNative('GdouEphemeralNetworking.swift'),
        'utf8'
      );
      fs.writeFileSync(
        path.join(appDir, 'GdouScheduleActivityAttributes.swift'),
        readIosNative('GdouScheduleActivityAttributes.swift'),
        'utf8'
      );
      fs.writeFileSync(
        path.join(appDir, 'GdouScheduleAppIntents.swift'),
        readIosNative('GdouScheduleAppIntents.swift'),
        'utf8'
      );

      // 2. Write iOS WidgetKit + ActivityKit (Dynamic Island) Extension target files
      const widgetDir = path.join(iosRoot, 'GdouScheduleWidgetExtension');
      fs.mkdirSync(widgetDir, { recursive: true });
      fs.writeFileSync(
        path.join(widgetDir, 'GdouScheduleWidget.swift'),
        readIosNative(path.join('widget', 'GdouScheduleWidget.swift')).replace(
          /__GDOU_APP_GROUP_ID__/g,
          appGroupId
        ),
        'utf8'
      );
      fs.writeFileSync(
        path.join(widgetDir, 'GdouWidgetActivityAttributes.swift'),
        readIosNative(path.join('widget', 'GdouWidgetActivityAttributes.swift')),
        'utf8'
      );
      fs.writeFileSync(
        path.join(widgetDir, 'Info.plist'),
        readIosNative(path.join('widget', 'Info.plist.template'))
          .replace(/__GDOU_VERSION__/g, version)
          .replace(/__GDOU_BUILD_NUMBER__/g, buildNumber),
        'utf8'
      );
      fs.writeFileSync(
        path.join(widgetDir, 'GdouScheduleWidgetExtension.entitlements'),
        readIosNative(path.join('widget', 'GdouScheduleWidgetExtension.entitlements.template')).replace(
          /__GDOU_APP_GROUP_ID__/g,
          appGroupId
        ),
        'utf8'
      );

      // 3. Ensure Bridging-Header imports <React/RCTHTTPRequestHandler.h>
      const bridgingHeaderPath = path.join(appDir, `${projectName}-Bridging-Header.h`);
      const importSnippet = `#if __has_include(<React/RCTHTTPRequestHandler.h>)\n#import <React/RCTHTTPRequestHandler.h>\n#endif\n`;
      if (fs.existsSync(bridgingHeaderPath)) {
        const existing = fs.readFileSync(bridgingHeaderPath, 'utf8');
        if (!existing.includes('RCTHTTPRequestHandler.h')) {
          fs.writeFileSync(bridgingHeaderPath, `${existing.trimEnd()}\n${importSnippet}`, 'utf8');
        }
      } else {
        fs.writeFileSync(bridgingHeaderPath, importSnippet, 'utf8');
      }

      return mod;
    },
  ]);
}

function withGdouIosXcodeSource(config) {
  return withXcodeProject(config, (mod) => {
    const projectName = mod.modRequest.projectName;
    const pbxProject = mod.modResults;
    const bundleId = config.ios?.bundleIdentifier || 'cn.edu.gdou.schedule';
    const widgetTargetName = 'GdouScheduleWidgetExtension';
    const widgetBundleId = `${bundleId}.widget`;
    const version = config.version || '2.0.0';
    const buildNumber = String(config.ios?.buildNumber || '13');

    const hasFileEnding = (suffix) => {
      const existingFiles = pbxProject.pbxFileReferenceSection();
      return Object.values(existingFiles).some(
        (entry) =>
          entry &&
          typeof entry === 'object' &&
          typeof entry.path === 'string' &&
          entry.path.replace(/"/g, '').endsWith(suffix)
      );
    };

    // 1. Main app Swift sources
    for (const swiftFile of [
      'GdouEphemeralNetworking.swift',
      'GdouScheduleActivityAttributes.swift',
      'GdouScheduleAppIntents.swift',
    ]) {
      if (!hasFileEnding(swiftFile)) {
        IOSConfig.XcodeUtils.addBuildSourceFileToGroup({
          filepath: `${projectName}/${swiftFile}`,
          groupName: projectName,
          project: pbxProject,
        });
      }
    }

    // 2. Deterministically add iOS WidgetKit + ActivityKit Extension target (idempotent)
    const existingTargets = pbxProject.pbxNativeTargetSection();
    const hasWidgetTarget = Object.values(existingTargets).some(
      (t) =>
        t &&
        typeof t === 'object' &&
        typeof t.name === 'string' &&
        t.name.replace(/"/g, '') === widgetTargetName
    );

    if (!hasWidgetTarget) {
      if (!pbxProject.hash.project.objects.PBXTargetDependency) {
        pbxProject.hash.project.objects.PBXTargetDependency = {};
      }
      if (!pbxProject.hash.project.objects.PBXContainerItemProxy) {
        pbxProject.hash.project.objects.PBXContainerItemProxy = {};
      }
      if (!pbxProject.hash.project.objects.PBXCopyFilesBuildPhase) {
        pbxProject.hash.project.objects.PBXCopyFilesBuildPhase = {};
      }

      const widgetGroupKey = pbxProject.pbxCreateGroup(widgetTargetName, widgetTargetName);
      if (pbxProject.hash.project.objects.PBXGroup?.[widgetGroupKey]) {
        pbxProject.hash.project.objects.PBXGroup[widgetGroupKey].isa = 'PBXGroup';
      }
      const rootProject = pbxProject.getFirstProject().firstProject;
      pbxProject.addToPbxGroup(widgetGroupKey, rootProject.mainGroup);

      const widgetTarget = pbxProject.addTarget(
        widgetTargetName,
        'app_extension',
        widgetTargetName,
        widgetBundleId
      );

      pbxProject.addBuildPhase([], 'PBXSourcesBuildPhase', 'Sources', widgetTarget.uuid);
      pbxProject.addBuildPhase([], 'PBXFrameworksBuildPhase', 'Frameworks', widgetTarget.uuid);
      pbxProject.addBuildPhase([], 'PBXResourcesBuildPhase', 'Resources', widgetTarget.uuid);

      pbxProject.addSourceFile(
        'GdouScheduleWidget.swift',
        { target: widgetTarget.uuid, lastKnownFileType: 'sourcecode.swift' },
        widgetGroupKey
      );
      pbxProject.addSourceFile(
        'GdouWidgetActivityAttributes.swift',
        { target: widgetTarget.uuid, lastKnownFileType: 'sourcecode.swift' },
        widgetGroupKey
      );
      pbxProject.addFile('Info.plist', widgetGroupKey);
      pbxProject.addFile('GdouScheduleWidgetExtension.entitlements', widgetGroupKey);

      const allFileRefs = pbxProject.pbxFileReferenceSection();
      for (const ref of Object.values(allFileRefs)) {
        if (!ref || typeof ref !== 'object') continue;
        for (const k of ['explicitFileType', 'lastKnownFileType', 'fileEncoding']) {
          if (ref[k] === undefined || ref[k] === 'undefined') {
            delete ref[k];
          }
        }
      }

      const allBuildFiles = pbxProject.pbxBuildFileSection();
      for (const bf of Object.values(allBuildFiles)) {
        if (!bf || typeof bf !== 'object') continue;
        if (
          typeof bf.fileRef_comment === 'string' &&
          bf.fileRef_comment.includes(`${widgetTargetName}.appex`)
        ) {
          bf.settings = { ATTRIBUTES: ['RemoveHeadersOnCopy'] };
        }
      }

      const xcConfigLists = pbxProject.pbxXCConfigurationList();
      const buildConfigs = pbxProject.pbxXCBuildConfigurationSection();
      const targetConfigList = xcConfigLists[widgetTarget.pbxNativeTarget.buildConfigurationList];
      if (targetConfigList && Array.isArray(targetConfigList.buildConfigurations)) {
        for (const cfgRef of targetConfigList.buildConfigurations) {
          const cfg = buildConfigs[cfgRef.value];
          if (!cfg || !cfg.buildSettings) continue;
          cfg.buildSettings.SDKROOT = 'iphoneos';
          cfg.buildSettings.PRODUCT_BUNDLE_IDENTIFIER = `"${widgetBundleId}"`;
          cfg.buildSettings.PRODUCT_BUNDLE_PACKAGE_TYPE = '"XPC!"';
          cfg.buildSettings.INFOPLIST_FILE = `"${widgetTargetName}/Info.plist"`;
          cfg.buildSettings.CODE_SIGN_ENTITLEMENTS = `"${widgetTargetName}/GdouScheduleWidgetExtension.entitlements"`;
          cfg.buildSettings.SWIFT_VERSION = '5.0';
          cfg.buildSettings.SWIFT_DEFAULT_ACTOR_ISOLATION = 'nonisolated';
          cfg.buildSettings.SWIFT_EMIT_LOC_STRINGS = 'YES';
          cfg.buildSettings.IPHONEOS_DEPLOYMENT_TARGET = '16.2';
          cfg.buildSettings.TARGETED_DEVICE_FAMILY = '"1,2"';
          cfg.buildSettings.SUPPORTS_MACCATALYST = 'NO';
          cfg.buildSettings.SKIP_INSTALL = 'YES';
          cfg.buildSettings.GENERATE_INFOPLIST_FILE = 'NO';
          cfg.buildSettings.APPLICATION_EXTENSION_API_ONLY = 'YES';
          cfg.buildSettings.ALWAYS_EMBED_SWIFT_STANDARD_LIBRARIES = 'NO';
          cfg.buildSettings.CLANG_ENABLE_MODULES = 'YES';
          cfg.buildSettings.CODE_SIGN_STYLE = 'Automatic';
          cfg.buildSettings.MARKETING_VERSION = `"${version}"`;
          cfg.buildSettings.CURRENT_PROJECT_VERSION = `"${buildNumber}"`;
          cfg.buildSettings.LD_RUNPATH_SEARCH_PATHS =
            '"$(inherited) @executable_path/Frameworks @executable_path/../../Frameworks"';
          if (cfg.name === 'Release') {
            cfg.buildSettings.SWIFT_OPTIMIZATION_LEVEL = '"-O"';
            cfg.buildSettings.SWIFT_COMPILATION_MODE = 'wholemodule';
          } else {
            cfg.buildSettings.SWIFT_OPTIMIZATION_LEVEL = '"-Onone"';
          }
        }
      }
    }

    return mod;
  });
}

function applyGdouIosMods(config) {
  config = withGdouIosInfoPlist(config);
  config = withGdouIosEntitlements(config);
  config = withGdouIosPodfileProperties(config);
  config = withGdouIosAppDelegate(config);
  config = withGdouIosNativeFiles(config);
  config = withGdouIosXcodeSource(config);
  return config;
}

module.exports = { applyGdouIosMods };
