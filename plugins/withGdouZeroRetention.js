const { applyGdouAndroidMods } = require('./mods/androidMods');
const { applyGdouIosMods } = require('./mods/iosMods');

/**
 * Expo CNG Config Plugin entry point for GDOU Schedule ("海大课表").
 * Modularized into:
 * - plugins/mods/androidMods.js + plugins/native/android/*
 * - plugins/mods/iosMods.js     + plugins/native/ios/*
 *
 * Enforces dual-platform zero-retention ephemeral networking, OTA bundle resolution,
 * AlarmKit / System Clock integration, WidgetKit / 4x4 Android Widgets, Dynamic Island,
 * Siri AppIntents, BGTaskScheduler refresh, and hardened release build configuration.
 */
function withGdouZeroRetention(config) {
  config = applyGdouAndroidMods(config);
  config = applyGdouIosMods(config);
  return config;
}

module.exports = withGdouZeroRetention;
