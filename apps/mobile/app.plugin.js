/**
 * Config plugin for EAS Build compatibility with Expo SDK 51 + RN 0.74.
 *
 * Fixes applied to the generated Podfile:
 * 1. Removes :privacy_file_aggregation_enabled — keyword not recognised by
 *    CocoaPods < 1.15 (EAS default image ships 1.14.3).
 * 2. Adds explicit pod 'React-jsinspector', :modular_headers => true so
 *    ExpoModulesCore (a Swift pod) can import it as a static library without
 *    use_modular_headers! globally (which causes ReactCommon redefinition errors).
 * 3. Injects DEFINES_MODULE=YES inside the existing post_install block as a
 *    belt-and-suspenders fix for Xcode to auto-generate a module map.
 */
const { withDangerousMod, withGradleProperties } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

const MODULAR_HEADERS_POD = `
  # Explicitly enable modular headers for React-jsinspector so ExpoModulesCore
  # (a Swift pod) can import it as a static library without use_modular_headers!
  pod 'React-jsinspector', :path => '../../../node_modules/react-native/ReactCommon/jsinspector-modern', :modular_headers => true
`;

const DEFINES_MODULE_FIX = `
    # Fix: belt-and-suspenders DEFINES_MODULE for React-jsinspector
    installer.pods_project.targets.each do |target|
      if target.name == 'React-jsinspector'
        target.build_configurations.each do |config|
          config.build_settings['DEFINES_MODULE'] = 'YES'
        end
      end
    end
`;

function withAndroidSdkVersion(config) {
  return withGradleProperties(config, (config) => {
    const props = config.modResults;
    const set = (key, value) => {
      const existing = props.find(p => p.type === 'property' && p.key === key);
      if (existing) {
        existing.value = value;
      } else {
        props.push({ type: 'property', key, value });
      }
    };
    // compileSdkVersion stays at 34 — expo-modules-core (SDK 51) does not compile
    // cleanly against SDK 35. Play Store only requires targetSdkVersion >= 35.
    set('android.targetSdkVersion', '35');
    return config;
  });
}

module.exports = function withPodfilePatch(config) {
  config = withAndroidSdkVersion(config);
  return withDangerousMod(config, [
    'ios',
    (config) => {
      const podfilePath = path.join(config.modRequest.platformProjectRoot, 'Podfile');
      let contents = fs.readFileSync(podfilePath, 'utf8');

      // Fix 1: remove :privacy_file_aggregation_enabled (CocoaPods < 1.15 compat)
      contents = contents.replace(
        /[ \t]*:privacy_file_aggregation_enabled\s*=>[^,\n]+,?\n?/g,
        ''
      );

      // Fix 2: inject explicit pod declaration with :modular_headers => true
      // Insert right after the target block opening line (any target name).
      // Guard against duplicate injection — skip if already present.
      if (!contents.includes("pod 'React-jsinspector'")) {
        contents = contents.replace(
          /(target '[^']+' do\n)/,
          `$1${MODULAR_HEADERS_POD}`
        );
      }

      // Fix 3: inject DEFINES_MODULE inside existing post_install block
      // Identifies the end of the post_install block by the post_integrate block that follows
      contents = contents.replace(
        /([ \t]+end\n)([ \t]*post_integrate)/,
        `$1${DEFINES_MODULE_FIX}$2`
      );

      fs.writeFileSync(podfilePath, contents);
      console.log('[withPodfilePatch] Patched Podfile: removed :privacy_file_aggregation_enabled, added React-jsinspector :modular_headers, added DEFINES_MODULE fix');
      return config;
    },
  ]);
};
