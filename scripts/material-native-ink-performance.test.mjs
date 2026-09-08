import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../modules/expo-pdf-annotation/ios/PdfAnnotationView.swift', import.meta.url), 'utf8');
const begin = source.slice(source.indexOf('  func beginStroke('), source.indexOf('  func appendPoint('));
const append = source.slice(source.indexOf('  func appendPoint('), source.indexOf('  func endStroke('));
const end = source.slice(source.indexOf('  func endStroke('), source.indexOf('  func cancelStroke('));
assert.match(begin, /ink.append\(pagePoint\)/, 'touch-down submits first sample immediately');
assert.match(source, /CGPath\(ellipseIn:/, 'one-sample strokes have visible dot geometry');
assert.match(append, /liveInkLayer\?\.append\(pagePoint\)/);
assert.doesNotMatch(append, /setNeedsDisplay|\.map|pagedStrokes/, 'Pencil move must not redraw history or reconvert old samples');
assert.match(source, /sampleCount >= 32/, 'active CGPath is bounded, including long strokes');
assert.match(source, /event.coalescedTouches\(for: touch\)/, 'confirmed coalesced samples are retained');
assert.doesNotMatch(source, /event.predictedTouches/, 'predicted input remains disabled');
assert.match(source, /host = pdfView.documentView/);
assert.match(source, /host.layer.addSublayer\(layer\)/, 'ink inherits native PDF scrolling and zoom');
assert.match(end, /savedInkLayers\[id\] = liveInkLayer/, 'pen-up retains the same rendered layer');
assert.ok(end.indexOf('liveInkLayer = nil') < end.indexOf('clearInProgress()',
  end.indexOf('pagedStrokes[pageNumber')), 'commit detaches live ownership before cleanup');
assert.match(source, /old.points == stroke.points/, 'same-id changed content invalidates layer cache');
console.log('Native ink performance guards: passed (physical latency and attachment still require owner evaluation).');
