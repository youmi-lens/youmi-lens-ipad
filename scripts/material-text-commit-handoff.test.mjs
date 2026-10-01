// Runs the ACTUAL native viewer/editor/commit methods in a standalone UIKit
// simulator app. Only Expo view construction/event delivery are shimmed.
// Asynchronous prop echoes are deliberately controlled, not production delays.
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const root = fileURLToPath(new URL('../', import.meta.url));
const native = readFileSync(join(root, 'modules/expo-pdf-annotation/ios/PdfAnnotationView.swift'), 'utf8');
if (!process.argv.includes('--observe-baseline')) {
  const commit = native.slice(native.indexOf('private func commitInlineTextEditorIfNeeded'), native.indexOf('private func presentTextActions'));
  assert.ok(commit.indexOf('stageTextCommit') < commit.indexOf('resignFirstResponder()'));
  assert.match(commit, /if annotationOverlay\.renderCommittedTextIfPossible[\s\S]*inlineTextEditor\.isHidden = true/);
  assert.doesNotMatch(commit, /asyncAfter|Timer|alpha\s*=|opacity\s*=|snapshotView|UIView\.animate/);
  const js = readFileSync(join(root, 'app/lecture-material/[lectureId]/[materialId].tsx'), 'utf8');
  assert.match(js, /id: annotationId \?\?/);
  assert.match(js, /event\.anchor, event\.annotationId\)/);
  assert.match(js, /setTextHistoryIntent\(action\.pageNumber, result\.textAnnotations\)/);
}
const dir = mkdtempSync(join(tmpdir(), 'youmi-text-handoff-'));
const app = join(dir, 'TextHandoff.app');
mkdirSync(app);
const xcrun = args => execFileSync('xcrun', args, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
const sdk = xcrun(['--sdk', 'iphonesimulator', '--show-sdk-path']).trim();
const devices = JSON.parse(xcrun(['simctl', 'list', 'devices', 'available', '--json']));
const ipad = Object.values(devices.devices).flat().find(d => d.name.includes('iPad Pro 11-inch'));
if (!ipad) throw Error('iPad simulator unavailable');
if (ipad.state !== 'Booted') xcrun(['simctl', 'boot', ipad.udid]);
xcrun(['simctl', 'bootstatus', ipad.udid, '-b']);
let source = readFileSync(join(root, 'modules/expo-pdf-annotation/ios/PdfAnnotationView.swift'), 'utf8')
  .replace('import ExpoModulesCore\n', '').replace(/\bprivate\s+/g, '');
source = source.replace('public required init(appContext:', 'public required init?(coder: NSCoder) { fatalError() }\n  public required init(appContext:');
source = source.replace('public func textViewDidChange(_ textView: UITextView) {', 'public func textViewDidChange(_ textView: UITextView) {\n    TextInputProbe.onChange?()');
writeFileSync(join(dir, 'Viewer.swift'), source);
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
const mode = process.argv.includes('--observe-baseline') ? 'observe' : 'verify';
writeFileSync(join(app, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.youmi.qa.text-handoff</string>
<key>CFBundleExecutable</key><string>TextHandoff</string>
<key>CFBundleName</key><string>TextHandoff</string>
<key>CFBundleVersion</key><string>1</string>
<key>CFBundleShortVersionString</key><string>1.0</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSRequiresIPhoneOS</key><true/>
<key>UIDeviceFamily</key><array><integer>2</integer></array>
<key>UIApplicationSupportsIndirectInputEvents</key><true/>
<key>UILaunchScreen</key><dict/>
</dict></plist>`);
xcrun(['swiftc', '-sdk', sdk, '-target', 'arm64-apple-ios17.0-simulator',
  join(dir, 'ExpoShim.swift'), join(dir, 'Viewer.swift'),
  join(root, 'modules/expo-pdf-annotation/ios/MaterialTextGeometry.swift'),
  join(root, 'modules/expo-pdf-annotation/ios/__tests__/material_text_handoff_fixture.swift'),
  '-o', join(app, 'TextHandoff')]);
execFileSync('codesign', ['--force', '--sign', '-', app], { stdio: 'pipe' });
xcrun(['simctl', 'install', ipad.udid, app]);
const output = xcrun(['simctl', 'launch', '--console', '--terminate-running-process', ipad.udid, 'com.youmi.qa.text-handoff', mode]);
console.log(output);
const marker = mode === 'observe' ? 'HANDOFF_BASELINE_GAP_PROVEN' : 'HANDOFF_FIX_PASS';
if (!output.includes(marker)) throw Error('Native handoff evidence missing: ' + marker);
if (mode === 'verify') assert.match(output, /HANDOFF_PENDING_INTENTS_PASS/);
console.log('Native handoff evidence directory: ' + dir);
