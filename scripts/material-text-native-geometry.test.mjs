// Generates a temporary harness from current production Swift (not copied math).
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const source = readFileSync(join(root, 'modules/expo-pdf-annotation/ios/PdfAnnotationView.swift'), 'utf8');
const start = source.indexOf('final class PageTextAnnotationLayer:');
const end = source.indexOf('/// Transparent UIView', start);
const structStart = source.indexOf('struct TextAnnotation:');
const structEnd = source.indexOf('struct TextAnnotationHit', structStart);
if ([start, end, structStart, structEnd].some(i => i < 0)) throw Error('Production layer extraction failed');
const dir = mkdtempSync(join(tmpdir(), 'youmi-material-text-geometry-'));
writeFileSync(join(dir, 'PageTextAnnotationLayer.swift'), 'import UIKit\n' + source.slice(start, end) + source.slice(structStart, structEnd));
const xcrun = args => execFileSync('xcrun', args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
const sdk = xcrun(['--sdk', 'iphonesimulator', '--show-sdk-path']).trim();
const devices = JSON.parse(xcrun(['simctl', 'list', 'devices', 'available', '--json']));
const ipad = Object.values(devices.devices).flat().find(d => d.name.includes('iPad Pro 11-inch'));
if (!ipad) throw Error('iPad simulator unavailable');
if (ipad.state !== 'Booted') xcrun(['simctl', 'boot', ipad.udid]);
xcrun(['simctl', 'bootstatus', ipad.udid, '-b']);
const exe = join(dir, 'material-text-geometry');
xcrun(['swiftc', '-sdk', sdk, '-target', 'arm64-apple-ios17.0-simulator',
  join(root, 'modules/expo-pdf-annotation/ios/MaterialTextGeometry.swift'),
  join(dir, 'PageTextAnnotationLayer.swift'),
  join(root, 'modules/expo-pdf-annotation/ios/__tests__/material_text_geometry_fixture.swift'), '-o', exe]);
const output = xcrun(['simctl', 'spawn', ipad.udid, exe]);
console.log(output);
if (!output.includes('MATERIAL_TEXT_GEOMETRY_PASS')) throw Error('Native geometry did not pass');
console.log('Native evidence directory: ' + dir);
