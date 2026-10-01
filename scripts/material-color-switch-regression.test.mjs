import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const slice = (source, startMarker, endMarker) => {
  const start = source.indexOf(startMarker);
  assert.ok(start >= 0, `missing start marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start);
  assert.ok(end > start, `missing end marker: ${endMarker}`);
  return source.slice(start, end);
};

const screen = read('../app/lecture-material/[lectureId]/[materialId].tsx');
const wrapper = read('../components/NativePdfAnnotationView.tsx');
const nativeTypes = read('../modules/expo-pdf-annotation/index.ts');
const nativeModule = read('../modules/expo-pdf-annotation/ios/PdfAnnotationModule.swift');

test('Pen color is lightweight native interaction state, not a live heavy-view prop', () => {
  const nativeView = slice(screen, '<NativePdfAnnotationView\n', 'onLoadComplete={handleNativeLoadComplete}');
  assert.doesNotMatch(nativeView, /penColor=\{nativePenColor\}/);
  assert.doesNotMatch(nativeView, /highlighterColor=\{nativeHighlighterColor\}/);
  assert.match(nativeTypes, /setPenColorAsync\?: \(color: string\) => Promise<void>/);
  assert.match(nativeTypes, /setHighlighterColorAsync\?: \(color: string\) => Promise<void>/);
  assert.match(nativeModule, /AsyncFunction\("setPenColorAsync"\)[\s\S]*view\.penColor = color/);
  assert.match(nativeModule, /AsyncFunction\("setHighlighterColorAsync"\)[\s\S]*view\.highlighterColor = color/);
});

test('Pen -> color change updates native color without changing native Pen mode', () => {
  const handler = slice(screen, 'const handleSelectNativeColor = useCallback', 'const handleSelectColor');
  assert.match(handler, /nativePenColorRef\.current = color;/);
  assert.match(handler, /pdfRef\.current\?\.setPenColor\(color\);/);
  assert.match(handler, /setNativePenColor\(color\);/);
  assert.doesNotMatch(handler, /setAnnotationMode|applyNativeAnnotationMode/);
});

test('Highlighter color uses the matching native command and does not change tool mode', () => {
  const handler = slice(screen, 'const handleSelectNativeColor = useCallback', 'const handleSelectColor');
  assert.match(handler, /nativeHighlighterColorRef\.current = color;/);
  assert.match(handler, /pdfRef\.current\?\.setHighlighterColor\(color\);/);
  assert.match(handler, /setNativeHighlighterColor\(color\);/);
  assert.doesNotMatch(handler, /setAnnotationMode|applyNativeAnnotationMode/);
});

test('an omitted live annotationMode prop cannot reset native interaction to PDF navigation', () => {
  assert.doesNotMatch(wrapper, /\sannotationMode=\{annotationMode\}/);
  assert.match(wrapper, /\.\.\.\(annotationMode === undefined \? \{\} : \{ annotationMode \}\)/);
  const modeProp = slice(nativeModule, 'Prop("annotationMode")', 'Prop("selectionShape")');
  assert.match(modeProp, /guard let mode else \{ return \}/);
  assert.match(modeProp, /view\.annotationMode = mode/);
  assert.doesNotMatch(modeProp, /\?\? "scroll"/);
});

test('absent color props cannot overwrite command-owned colors on a later native view update', () => {
  const penProp = slice(nativeModule, 'Prop("penColor")', 'Prop("penWidth")');
  const highlighterProp = slice(nativeModule, 'Prop("highlighterColor")', 'Prop("highlighterWidth")');
  assert.match(penProp, /guard let color else \{ return \}/);
  assert.doesNotMatch(penProp, /\?\? "#061B34"/);
  assert.match(highlighterProp, /guard let color else \{ return \}/);
  assert.doesNotMatch(highlighterProp, /\?\? "#FFE066"/);
});

test('native view load restores current colors before restoring the current tool mode', () => {
  const handler = slice(screen, 'const handleNativeLoadComplete = useCallback', 'const handleNativePageChanged');
  const pen = handler.indexOf('setPenColor(nativePenColorRef.current)');
  const highlighter = handler.indexOf('setHighlighterColor(nativeHighlighterColorRef.current)');
  const mode = handler.indexOf('setAnnotationMode(nativeAnnotationModeRef.current)');
  assert.ok(pen >= 0 && highlighter > pen && mode > highlighter);
});

test('color-only transitions cannot synchronously serialize or mutate annotation payloads', () => {
  const handler = slice(screen, 'const handleSelectNativeColor = useCallback', 'const handleSelectColor');
  assert.doesNotMatch(handler, /JSON\.stringify|materialAnnotationPersistence|replaceMaterial|setNativeAnnotationsVersion|requestImmediateNativeAnnotations/);
});

test('color A -> B -> A and Pen -> Eraser -> Pen retain explicit native commands', () => {
  const colorHandler = slice(screen, 'const handleSelectNativeColor = useCallback', 'const handleSelectColor');
  const modeHandler = slice(screen, 'const applyNativeAnnotationMode = useCallback', '// Refs so');
  assert.match(colorHandler, /setPenColor\(color\)/);
  assert.match(modeHandler, /setAnnotationMode\(next\)/);
  assert.match(screen, /applyNativeAnnotationMode\('eraser'\)/);
  assert.match(screen, /applyNativeAnnotationMode\(restored\)/);
});
