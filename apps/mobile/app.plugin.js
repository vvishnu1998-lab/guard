/**
 * Config plugin for EAS Build compatibility with Expo SDK 51 + RN 0.74.
 *
 * Fixes applied to the generated Podfile:
 * 1. Removes :privacy_file_aggregation_enabled — keyword not recognised by
 *    CocoaPods < 1.15 (EAS default image ships 1.14.3).
 * 2. Appends a post_install hook that sets DEFINES_MODULE=YES on
 *    React-jsinspector so ExpoModulesCore (a Swift pod) can import it as a
 *    static library without requiring global use_modular_headers! (which causes
 *    ReactCommon redefinition errors on Xcode 16).
 */
const { withDangerousMod } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

const JSINSPECTOR_FIX = `
# Fix: ExpoModulesCore (Swift) needs React-jsinspector to declare a module.
# Setting DEFINES_MODULE=YES avoids needing global use_modular_headers! which
# causes ReactCommon redefinition errors on Xcode 16.
post_install do |installer|
  installer.pods_project.targets.each do |target|
    if target.name == 'React-jsinspector'
      target.build_configurations.each do |config|
        config.build_settings['DEFINES_MODULE'] = 'YES'
      end
    end
  end
end
`;

module.exports = function withPodfilePatch(config) {
  return withDangerousMod(config, [
    'ios',
    (config) => {
      const podfilePath = path.join(config.modRequest.platformProjectRoot, 'Podfile');
      let contents = fs.readFileSync(podfilePath, 'utf8');

      // Fix 1: remove :privacy_file_aggregation_enabled
      contents = contents.replace(
        /[ \t]*:privacy_file_aggregation_enabled\s*=>[^,\n]+,?\n?/g,
        ''
      );

      // Fix 2: append DEFINES_MODULE post_install hook
      contents = contents + JSINSPECTOR_FIX;

      fs.writeFileSync(podfilePath, contents);
      console.log('[withPodfilePatch] Patched Podfile: removed :privacy_file_aggregation_enabled, added DEFINES_MODULE fix');
      return config;
    },
  ]);
};
