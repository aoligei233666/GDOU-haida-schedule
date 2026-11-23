const baseConfig = require('./app.json');

/**
 * Dynamic Expo config wrapping app.json as the single source of version truth.
 *
 * When EXPO_PUBLIC_APP_DISTRIBUTION is "testflight" or "appstore":
 * - Strips third-party sideload URL schemes (feather / esign / sidestore / altstore)
 *   to comply with Apple App Review Guidelines 2.4.5 / 2.5.2.
 * - Uses personal bundleIdentifier (EXPO_IOS_BUNDLE_ID or com.aoligei233666.haidaschedule)
 *   so Apple Developer Portal does not conflict with university-owned reverse domains.
 */
module.exports = () => {
  const dist = (process.env.EXPO_PUBLIC_APP_DISTRIBUTION || 'sideload').toLowerCase();
  const isAppleOfficialStore = dist === 'testflight' || dist === 'appstore';

  const expo = JSON.parse(JSON.stringify(baseConfig.expo));

  if (isAppleOfficialStore) {
    expo.ios = expo.ios || {};
    expo.ios.bundleIdentifier =
      (process.env.EXPO_IOS_BUNDLE_ID || '').trim() || 'com.aoligei233666.haidaschedule';
    if (expo.ios.infoPlist) {
      delete expo.ios.infoPlist.LSApplicationQueriesSchemes;
      delete expo.ios.infoPlist.NSUserTrackingUsageDescription;
      expo.ios.infoPlist.ITSAppUsesNonExemptEncryption = false;
    }
  }

  return { expo };
};
