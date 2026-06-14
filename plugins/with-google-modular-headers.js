const { withPodfile } = require('@expo/config-plugins');

const POD_MARKER = '# Google Sign-In transitive Swift dependencies';
const MODULAR_PODS = `${POD_MARKER}
  pod 'GoogleUtilities', :modular_headers => true
  pod 'RecaptchaInterop', :modular_headers => true`;

module.exports = function withGoogleModularHeaders(config) {
  return withPodfile(config, (podfileConfig) => {
    const podfile = podfileConfig.modResults.contents;
    if (podfile.includes(POD_MARKER)) return podfileConfig;

    const anchor = '  use_expo_modules!';
    if (!podfile.includes(anchor)) {
      throw new Error('Unable to locate use_expo_modules! in the generated Podfile.');
    }

    podfileConfig.modResults.contents = podfile.replace(
      anchor,
      `${anchor}\n\n${MODULAR_PODS}`,
    );
    return podfileConfig;
  });
};
