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

// 3. Hard-alias react/react-jsx-runtime to the mobile copy. The monorepo root
// has react@18 (hoisted from apps/web) and apps/mobile uses react@19. Without
// this override, react-native (at root) Node-resolves react@18 via the root
// node_modules walk before Metro consults nodeModulesPaths, and RN 0.81's
// Fabric renderer crashes on `ReactSharedInternals.S` (a React-19-only slot).
// extraNodeModules is a fallback only — we need resolveRequest to override.
const REACT_ALIASES = {
  'react': path.resolve(projectRoot, 'node_modules/react'),
  'react/jsx-runtime': path.resolve(projectRoot, 'node_modules/react/jsx-runtime'),
  'react/jsx-dev-runtime': path.resolve(projectRoot, 'node_modules/react/jsx-dev-runtime'),
};

// @react-navigation/* must also be deduped. expo-router bundles its own copies
// under node_modules/expo-router/node_modules/@react-navigation/*. Mobile has
// duplicate top-level copies. Two instances of the same nav package = two
// distinct React Context objects → "Couldn't find the prevent remove context"
// when a consumer rendered by one instance reads context from the other.
const EXPO_ROUTER_NAV = path.resolve(monorepoRoot, 'node_modules/expo-router/node_modules/@react-navigation');
const NAV_ALIASES = {
  '@react-navigation/native': path.join(EXPO_ROUTER_NAV, 'native'),
  '@react-navigation/core': path.join(EXPO_ROUTER_NAV, 'core'),
  '@react-navigation/routers': path.join(EXPO_ROUTER_NAV, 'routers'),
  '@react-navigation/elements': path.join(EXPO_ROUTER_NAV, 'elements'),
  '@react-navigation/bottom-tabs': path.join(EXPO_ROUTER_NAV, 'bottom-tabs'),
};

// ── Web stubs for native-only modules ────────────────────────────────────────
const WEB_STUBS = {
  'expo-local-authentication': path.resolve(projectRoot, 'web-stubs/expo-local-authentication.js'),
  'expo-task-manager':         path.resolve(projectRoot, 'web-stubs/expo-task-manager.js'),
  'expo-secure-store':         path.resolve(projectRoot, 'web-stubs/expo-secure-store.js'),
};

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (REACT_ALIASES[moduleName]) {
    return context.resolveRequest(context, REACT_ALIASES[moduleName], platform);
  }
  if (NAV_ALIASES[moduleName]) {
    return context.resolveRequest(context, NAV_ALIASES[moduleName], platform);
  }
  if (platform === 'web' && WEB_STUBS[moduleName]) {
    return { filePath: WEB_STUBS[moduleName], type: 'sourceFile' };
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
