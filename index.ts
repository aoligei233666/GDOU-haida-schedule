import { registerRootComponent } from 'expo';
import { Image, Platform } from 'react-native';

import App from './App';

// Ensure bundled fonts/icons (Ionicons) resolve from APK native resources when running an OTA JS bundle on Android
if (Platform.OS === 'android') {
  const resolveAsset = Image.resolveAssetSource as unknown as {
    setCustomSourceTransformer?: (fn: (resolver: {
      isLoadedFromServer: () => boolean;
      isLoadedFromFileSystem: () => boolean;
      assetServerURL: () => unknown;
      resourceIdentifierWithoutScale: () => unknown;
      defaultAsset: () => unknown;
    }) => unknown) => void;
  };
  if (typeof resolveAsset?.setCustomSourceTransformer === 'function') {
    resolveAsset.setCustomSourceTransformer((resolver) => {
      if (resolver.isLoadedFromServer()) {
        return resolver.assetServerURL();
      }
      if (resolver.isLoadedFromFileSystem()) {
        return resolver.resourceIdentifierWithoutScale();
      }
      return resolver.defaultAsset();
    });
  }
}

registerRootComponent(App);
