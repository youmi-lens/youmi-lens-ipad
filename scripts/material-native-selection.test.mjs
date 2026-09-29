import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'youmi-native-selection-'));
const app = join(dir, 'MaterialSelection.app');
mkdirSync(app);
const xcrun = (args) => execFileSync('xcrun', args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
const sdk = xcrun(['--sdk', 'iphonesimulator', '--show-sdk-path']).trim();
const devices = JSON.parse(xcrun(['simctl', 'list', 'devices', 'available', '--json']));
const ipad = Object.values(devices.devices).flat().find((device) => device.name.includes('iPad Pro 11-inch'));
if (!ipad) throw Error('iPad simulator unavailable');
if (ipad.state !== 'Booted') xcrun(['simctl', 'boot', ipad.udid]);
xcrun(['simctl', 'bootstatus', ipad.udid, '-b']);

let source = readFileSync(join(root, 'modules/expo-pdf-annotation/ios/PdfAnnotationView.swift'), 'utf8')
  .replace('import ExpoModulesCore\n', '').replace(/\bprivate\s+/g, '');
source = source.replace('public required init(appContext:', 'public required init?(coder: NSCoder) { fatalError() }\n  public required init(appContext:');
writeFileSync(join(dir, 'Viewer.swift'), source);
// The shared selection state-machine case table is replayed against the native reducer.
const casesJson = readFileSync(join(root, 'scripts/fixtures/selection-machine-cases.json'), 'utf8');
const fixtureSource = readFileSync(join(root, 'modules/expo-pdf-annotation/ios/__tests__/material_selection_fixture.swift'), 'utf8')
  .replace('__SELECTION_CASES_JSON__', casesJson);
writeFileSync(join(dir, 'Fixture.swift'), fixtureSource);
writeFileSync(join(dir, 'ExpoShim.swift'), `import UIKit
public class AppContext {}
public class ExpoView: UIView {
  public required init(appContext: AppContext? = nil) { super.init(frame: .zero) }
  public required init?(coder: NSCoder) { fatalError() }
}
final class EventDispatcher {
  var handler: (([String: Any]) -> Void)?
  func callAsFunction(_ payload: [String: Any]) { handler?(payload) }
}
`);
writeFileSync(join(app, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.youmi.qa.material-selection</string>
<key>CFBundleExecutable</key><string>MaterialSelection</string>
<key>CFBundleName</key><string>MaterialSelection</string>
<key>CFBundleVersion</key><string>1</string>
<key>CFBundleShortVersionString</key><string>1.0</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSRequiresIPhoneOS</key><true/>
<key>UIDeviceFamily</key><array><integer>2</integer></array>
<key>UILaunchScreen</key><dict/>
</dict></plist>`);
xcrun(['swiftc', '-sdk', sdk, '-target', 'arm64-apple-ios17.0-simulator',
  join(dir, 'ExpoShim.swift'), join(dir, 'Viewer.swift'),
  join(root, 'modules/expo-pdf-annotation/ios/MaterialTextGeometry.swift'),
  join(dir, 'Fixture.swift'),
  '-o', join(app, 'MaterialSelection')]);
execFileSync('codesign', ['--force', '--sign', '-', app]);
xcrun(['simctl', 'install', ipad.udid, app]);
const output = xcrun(['simctl', 'launch', '--console', '--terminate-running-process', ipad.udid, 'com.youmi.qa.material-selection']);
console.log(output);
assert.match(output, /NATIVE_SELECTION_FIXTURE_PASS/);
assert.match(output, /NATIVE_SHAPE_FIXTURE_PASS/);
assert.match(output, /NATIVE_SHAPE_MODEL_PASS/);
assert.match(output, /NATIVE_SHAPE_EDIT_PASS scale=0.5/);
assert.match(output, /NATIVE_SHAPE_EDIT_PASS scale=1.0/);
assert.match(output, /NATIVE_SHAPE_EDIT_PASS scale=2.0/);
assert.match(output, /NATIVE_SHAPE_ROTATED_PASS/);
// Finger handle editing parity with Notebook (RC-1.2): handle > body move > page, at every zoom and on a rotated page.
assert.match(output, /NATIVE_FINGER_HANDLE_PASS scale=0.5/);
assert.match(output, /NATIVE_FINGER_HANDLE_PASS scale=1.0/);
assert.match(output, /NATIVE_FINGER_HANDLE_PASS scale=2.0/);
assert.match(output, /NATIVE_FINGER_HANDLE_PARITY_PASS/);
assert.equal((output.match(/SELECTION_PASS/g) ?? []).length, 6);
assert.match(output, /SELECTION_BOX_CORNER_PASS/);
assert.equal((output.match(/SELECTION_MOVE_PASS/g) ?? []).length, 3);
assert.match(output, /SELECTION_MOVE_ROTATED_PASS/);
assert.match(output, /SELECTION_OUTLINE_PASS/);
assert.match(output, /INK_GEOMETRY_PASS/);
assert.match(output, /SHAPE_SNAP_HOLD_PASS/);
assert.match(output, /INK_RESEND_NOOP_PASS resends=50 draws=0 skipped=50/);
for (const marker of [
  'NATIVE_SELECTION_MACHINE_PASS', 'NATIVE_SELECTION_PERSIST_PASS', 'NATIVE_SELECTION_CANCEL_PASS',
  'NATIVE_FINGER_ROUTING_PASS', 'NATIVE_SELECTION_RECONCILE_PASS', 'NATIVE_SCALE_CLAMP_PASS',
  'NATIVE_SELECTION_ROTATED_PASS', 'NATIVE_SELECTION_INTERACTION_PASS',
  'NATIVE_REAL_ELLIPSE_PASS', 'NATIVE_PEN_TOOL_STATE_PASS', 'NATIVE_ELLIPSE_HANDLES_PASS', 'NATIVE_PEN_TAP_ROTATED_PASS',
]) assert.match(output, new RegExp(marker), marker);
for (const scale of ['0.5', '1.0', '2.0']) {
  assert.match(output, new RegExp(`NATIVE_FINGER_MOVE_PASS scale=${scale}`));
  assert.match(output, new RegExp(`NATIVE_PINCH_SCALE_PASS scale=${scale}`));
  assert.match(output, new RegExp(`NATIVE_PEN_TAP_PASS scale=${scale}`));
}
