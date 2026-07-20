import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/** Mirror of `lib/recording/r6VerifyGate.ts` — keep in sync via source assert below. */
function isR6SimulatorVerifyEnabled({ isDev, envValue }) {
  return isDev === true && envValue === '1';
}

assert.equal(isR6SimulatorVerifyEnabled({ isDev: true, envValue: '1' }), true);
assert.equal(
  isR6SimulatorVerifyEnabled({ isDev: false, envValue: '1' }),
  false,
  'release __DEV__ false must disable',
);
assert.equal(isR6SimulatorVerifyEnabled({ isDev: true, envValue: '0' }), false);
assert.equal(isR6SimulatorVerifyEnabled({ isDev: true, envValue: undefined }), false);
assert.equal(
  isR6SimulatorVerifyEnabled({ isDev: true, envValue: 'true' }),
  false,
  'only exact string 1 enables',
);
assert.equal(isR6SimulatorVerifyEnabled({ isDev: true, envValue: ' 1' }), false);
assert.equal(isR6SimulatorVerifyEnabled({ isDev: false, envValue: undefined }), false);

const gateSource = readFileSync(new URL('../lib/recording/r6VerifyGate.ts', import.meta.url), 'utf8');
assert.match(
  gateSource,
  /return isDev === true && envValue === '1'/,
  'gate helper must fail closed unless __DEV__ and exact env string 1',
);

const layout = readFileSync(new URL('../app/_layout.tsx', import.meta.url), 'utf8');
assert.doesNotMatch(
  layout,
  /import\s+\{\s*R6SimulatorVerifyHost\s*\}\s+from/,
  'production layout must not statically import the R6 host',
);
assert.match(
  layout,
  /isR6SimulatorVerifyEnabled\(\)/,
  'layout mount must use the shared fail-closed R6 gate helper',
);
assert.match(
  layout,
  /require\('@\/lib\/recording\/R6SimulatorVerifyHost'\)/,
  'R6 host must be loaded only via gated require',
);

const envExample = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
assert.doesNotMatch(
  envExample,
  /EXPO_PUBLIC_R6_SIMULATOR_VERIFY\s*=\s*1/,
  '.env.example must never enable R6 simulator verify',
);

const eas = JSON.parse(readFileSync(new URL('../eas.json', import.meta.url), 'utf8'));
const productionEnv = eas.build?.production?.env ?? {};
assert.notEqual(
  productionEnv.EXPO_PUBLIC_R6_SIMULATOR_VERIFY,
  '1',
  'EAS production profile must not enable R6 simulator verify',
);
assert.notEqual(
  productionEnv.EXPO_PUBLIC_NATIVE_RECORDER_DOGFOOD,
  '1',
  'EAS production profile must not enable dogfood by default',
);

const moduleSwift = readFileSync(
  new URL('../modules/expo-durable-recorder/ios/ExpoDurableRecorderModule.swift', import.meta.url),
  'utf8',
);
assert.match(
  moduleSwift,
  /#if DEBUG[\s\S]*performCheckpointForTesting[\s\S]*#endif/,
  'Expo AsyncFunction checkpoint test hook must be DEBUG-only',
);
assert.match(
  moduleSwift,
  /#if DEBUG[\s\S]*simulateInterruptionBeganForTesting[\s\S]*#endif/,
  'Expo interruption test hook must be DEBUG-only',
);

const artifact = JSON.parse(
  readFileSync(
    new URL('../docs/verification/r6-simulator-artifacts/latest-results.json', import.meta.url),
    'utf8',
  ),
);
assert.equal(
  artifact.simulator?.udid,
  '[redacted]',
  'committed Simulator artifacts must not include raw device UDIDs',
);

console.log('R6 verification gate isolation tests passed.');
