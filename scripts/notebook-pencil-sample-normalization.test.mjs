// Compiles and runs the ACTUAL production NotebookPencilSample.swift (not a
// copy) against a synthetic fixture on an iPad Simulator — same technique as
// scripts/material-text-native-geometry.test.mjs.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'youmi-notebook-pencil-sample-'));
const xcrun = (args) => execFileSync('xcrun', args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
const sdk = xcrun(['--sdk', 'iphonesimulator', '--show-sdk-path']).trim();
const devices = JSON.parse(xcrun(['simctl', 'list', 'devices', 'available', '--json']));
const ipad = Object.values(devices.devices).flat().find((d) => d.name.includes('iPad Pro 11-inch'));
if (!ipad) throw new Error('iPad simulator unavailable');
if (ipad.state !== 'Booted') xcrun(['simctl', 'boot', ipad.udid]);
xcrun(['simctl', 'bootstatus', ipad.udid, '-b']);

const exe = join(dir, 'notebook-pencil-sample');
xcrun([
  'swiftc', '-sdk', sdk, '-target', 'arm64-apple-ios17.0-simulator',
  join(root, 'modules/expo-notebook-pencil-sampler/ios/NotebookPencilSample.swift'),
  join(root, 'modules/expo-notebook-pencil-sampler/ios/__tests__/notebook_pencil_sample_fixture.swift'),
  '-o', exe,
]);
const output = xcrun(['simctl', 'spawn', ipad.udid, exe]);
console.log(output);
if (!output.includes('NOTEBOOK_PENCIL_SAMPLE_PASS')) throw new Error('Native pressure normalization did not pass');
console.log('Native evidence directory: ' + dir);
