const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

// EXPO_USE_METRO_WORKSPACE_ROOT=1 (set in package.json web script) tells
// getDefaultConfig to auto-detect the monorepo root and configure watchFolders
// + nodeModulesPaths so Metro can find hoisted packages.
const config = getDefaultConfig(__dirname);

// ── Web stubs for native-only modules ────────────────────────────────────────
// These packages have no working web implementation. On web, redirect to
// lightweight stubs so the app boots cleanly in Chrome for QA testing.
const WEB_STUBS = {
  'expo-local-authentication': path.resolve(__dirname, 'web-stubs/expo-local-authentication.js'),
  'expo-task-manager':         path.resolve(__dirname, 'web-stubs/expo-task-manager.js'),
  'expo-secure-store':         path.resolve(__dirname, 'web-stubs/expo-secure-store.js'),
};

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (platform === 'web' && WEB_STUBS[moduleName]) {
    return { filePath: WEB_STUBS[moduleName], type: 'sourceFile' };
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
