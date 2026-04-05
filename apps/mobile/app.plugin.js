/**
 * Config plugin: removes :privacy_file_aggregation_enabled from the generated
 * Podfile. This keyword was introduced in CocoaPods 1.15+ but EAS build servers
 * run 1.14.3, causing pod install to fail with "unknown keyword".
 */
const { withDangerousMod } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

module.exports = function withPodfilePatch(config) {
  return withDangerousMod(config, [
    'ios',
    (config) => {
      const podfilePath = path.join(config.modRequest.platformProjectRoot, 'Podfile');
      const contents = fs.readFileSync(podfilePath, 'utf8');
      const patched = contents.replace(
        /[ \t]*:privacy_file_aggregation_enabled\s*=>[^,\n]+,?\n?/g,
        ''
      );
      fs.writeFileSync(podfilePath, patched);
      console.log('[withPodfilePatch] Removed :privacy_file_aggregation_enabled from Podfile');
      return config;
    },
  ]);
};
