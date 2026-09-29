const { withGradleProperties } = require('@expo/config-plugins');

module.exports = function withAndroidSdkVersion(config) {
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
    // Play requires targetSdkVersion 36 for production releases as of this
    // release; vc25 was rejected for targeting 35. Expo SDK 54 defaults to 36
    // for both values, and the previous '35' here was a leftover from SDK 51.
    // compileSdkVersion is pinned alongside it because you cannot target 36
    // while compiling against 35, and the repo otherwise inherits it from a
    // prebuild template that is not checked in.
    set('android.targetSdkVersion', '36');
    set('android.compileSdkVersion', '36');
    return config;
  });
};
