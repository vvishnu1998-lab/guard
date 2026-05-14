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
    set('android.targetSdkVersion', '35');
    return config;
  });
};
