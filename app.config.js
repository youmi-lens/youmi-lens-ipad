/**
 * Dev/Production app variants — same EAS project, different bundle identifier,
 * so a local development build can be installed side-by-side with the real
 * production Youmi Lens on the same physical iPad without ever replacing it.
 *
 * `config` here is app.json's own `expo` object, parsed by Expo BEFORE this
 * file runs — app.json remains the single source of truth for everything.
 * When APP_VARIANT is unset (any normal `eas build`/`expo run` without it,
 * including every existing production/preview EAS profile), this returns
 * app.json completely unchanged — zero behavior change for production.
 *
 * Set APP_VARIANT=development to build the dev variant, e.g.:
 *   APP_VARIANT=development npx expo run:ios --device "..."
 * The `development` and `development-simulator` EAS build profiles
 * (eas.json) already set this automatically.
 */
module.exports = ({ config }) => {
  const isDev = process.env.APP_VARIANT === 'development';
  if (!isDev) return config;

  // Physical Course Material text forensics only. This is deliberately an
  // Info.plist build switch (not a product/runtime feature flag): it is absent
  // from every production variant and only enables bounded native diagnostic
  // output in the explicitly named internal QA profile.
  const materialTextTrace = process.env.YOUMI_MATERIAL_TEXT_TRACE === '1';

  return {
    ...config,
    name: 'Youmi Lens Dev',
    // Different custom URL scheme too — both apps installed at once must not
    // both claim `youmilens://`, which would make deep-link resolution
    // ambiguous between them.
    scheme: 'youmilensdev',
    ios: {
      ...config.ios,
      bundleIdentifier: `${config.ios.bundleIdentifier}.dev`,
      infoPlist: {
        ...config.ios?.infoPlist,
        YoumiMaterialTextTrace: materialTextTrace,
      },
    },
  };
};
