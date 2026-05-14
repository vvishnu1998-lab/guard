// Official Expo monorepo Metro config
// https://docs.expo.dev/guides/monorepos/
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
const monorepoRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

// 1. Watch all files within the monorepo
config.watchFolders = [monorepoRoot, ...(config.watchFolders || [])];

// 2. Let Metro know where to resolve packages (local first, then monorepo root)
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(monorepoRoot, 'node_modules'),
];

// ── Web stubs for native-only modules ────────────────────────────────────────
const WEB_STUBS = {
  'expo-local-authentication': path.resolve(projectRoot, 'web-stubs/expo-local-authentication.js'),
  'expo-task-manager':         path.resolve(projectRoot, 'web-stubs/expo-task-manager.js'),
  'expo-secure-store':         path.resolve(projectRoot, 'web-stubs/expo-secure-store.js'),
};

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (platform === 'web' && WEB_STUBS[moduleName]) {
    return { filePath: WEB_STUBS[moduleName], type: 'sourceFile' };
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
