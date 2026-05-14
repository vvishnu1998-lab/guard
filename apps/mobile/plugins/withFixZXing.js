// Xcode 26 compatibility patch for ZXingObjC (pulled in transitively by expo-camera).
// Replaces deprecated TARGET_IPHONE_SIMULATOR macro with TARGET_OS_SIMULATOR.
const { withDangerousMod } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

module.exports = function withFixZXing(config) {
  return withDangerousMod(config, [
    'ios',
    async (config) => {
      const podfilePath = path.join(config.modRequest.platformProjectRoot, 'Podfile');
      if (!fs.existsSync(podfilePath)) return config;

      let podfile = fs.readFileSync(podfilePath, 'utf8');

      const marker = '# NETRAOPS_ZXING_PATCH';
      if (podfile.includes(marker)) return config;

      const hook = `
  ${marker}
  Dir.glob(File.join(installer.sandbox.pods_root, 'ZXingObjC/**/*.m')).each do |f|
    text = File.read(f)
    File.open(f, 'w') { |file| file.puts(text.gsub('TARGET_IPHONE_SIMULATOR', 'TARGET_OS_SIMULATOR')) }
  end
`;

      if (podfile.includes('post_install do |installer|')) {
        podfile = podfile.replace(
          /post_install do \|installer\|/,
          `post_install do |installer|${hook}`
        );
      } else {
        podfile += `\npost_install do |installer|${hook}\nend\n`;
      }

      fs.writeFileSync(podfilePath, podfile);
      return config;
    },
  ]);
};
