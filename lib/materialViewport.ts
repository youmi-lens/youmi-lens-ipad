import type { MaterialViewport } from './models';

export function normalizeMaterialViewport(
  value: unknown,
  totalPages: number,
  legacyPage?: number,
): MaterialViewport | undefined {
  const fallback = Number.isFinite(legacyPage) ? Math.max(1, Math.min(totalPages || 1, Math.floor(legacyPage!))) : undefined;
  if (!value || typeof value !== 'object') {
    return fallback ? { version: 1, pageIndex: fallback, scaleFactor: 1, anchorX: 0, anchorY: 0 } : undefined;
  }
  const source = value as Partial<MaterialViewport>;
  if (source.version !== 1 || !Number.isFinite(source.pageIndex) || !Number.isFinite(source.scaleFactor) ||
      !Number.isFinite(source.anchorX) || !Number.isFinite(source.anchorY)) return fallback
    ? { version: 1, pageIndex: fallback, scaleFactor: 1, anchorX: 0, anchorY: 0 } : undefined;
  const pageIndex = source.pageIndex as number;
  const scaleFactor = source.scaleFactor as number;
  const anchorX = source.anchorX as number;
  const anchorY = source.anchorY as number;
  return {
    version: 1,
    pageIndex: Math.max(1, Math.min(totalPages || 1, Math.floor(pageIndex))),
    scaleFactor: Math.max(0.01, scaleFactor),
    anchorX: Math.max(0, anchorX),
    anchorY: Math.max(0, anchorY),
  };
}

export function materialViewportEqual(a?: MaterialViewport, b?: MaterialViewport): boolean {
  return a?.version === b?.version && a?.pageIndex === b?.pageIndex &&
    a?.scaleFactor === b?.scaleFactor && a?.anchorX === b?.anchorX && a?.anchorY === b?.anchorY;
}
