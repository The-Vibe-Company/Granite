import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface AttachedAsset {
  file: string;
  path: string;
  relative_path: string;
  markdown: string;
  mime_type: string;
  sha256: string;
  resource_uri: string;
}

const MIME_TYPES: Record<string, string> = {
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.mp4': 'video/mp4',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain',
  '.webm': 'video/webm',
  '.webp': 'image/webp',
  '.xml': 'application/xml',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
};

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg']);

export function attachAsset(vaultRoot: string, filePath: string): AttachedAsset {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const assetsDir = path.join(vaultRoot, 'assets');
  fs.mkdirSync(assetsDir, { recursive: true });

  const fileName = path.basename(filePath);
  const destPath = path.join(assetsDir, fileName);
  let finalName = fileName;

  if (fs.existsSync(destPath)) {
    const ext = path.extname(fileName);
    const base = path.basename(fileName, ext);
    finalName = `${base}-${Date.now()}${ext}`;
  }

  const finalPath = path.join(assetsDir, finalName);
  fs.copyFileSync(filePath, finalPath);

  const relativePath = path.posix.join('assets', finalName);
  const ext = path.extname(finalName).toLowerCase();

  return {
    file: finalName,
    path: finalPath,
    relative_path: relativePath,
    markdown: IMAGE_EXTS.has(ext) ? `![${finalName}](${relativePath})` : `[${finalName}](${relativePath})`,
    mime_type: getAssetMimeType(finalName),
    sha256: sha256File(finalPath),
    resource_uri: assetResourceUri(finalName),
  };
}

export function assetResourceUri(fileName: string): string {
  return `granite://assets/${encodeURIComponent(fileName)}`;
}

export function listAssetFiles(vaultRoot: string): string[] {
  const assetsDir = path.join(vaultRoot, 'assets');
  if (!fs.existsSync(assetsDir)) {
    return [];
  }

  return fs.readdirSync(assetsDir)
    .filter(file => fs.statSync(path.join(assetsDir, file)).isFile())
    .sort((a, b) => a.localeCompare(b));
}

export function completeAssetFiles(vaultRoot: string, prefix = ''): string[] {
  const normalizedPrefix = prefix.toLowerCase();
  return listAssetFiles(vaultRoot)
    .filter(file => file.toLowerCase().startsWith(normalizedPrefix))
    .slice(0, 25);
}

export function readAssetResource(vaultRoot: string, fileName: string):
  | { uri: string; mimeType: string; text: string }
  | { uri: string; mimeType: string; blob: string } {
  const resolvedName = sanitizeAssetFileName(fileName);
  const fullPath = path.join(vaultRoot, 'assets', resolvedName);

  if (!fs.existsSync(fullPath)) {
    throw new Error(`Asset not found: ${resolvedName}`);
  }

  const mimeType = getAssetMimeType(resolvedName);
  const buffer = fs.readFileSync(fullPath);
  const uri = assetResourceUri(resolvedName);

  if (isTextMimeType(mimeType)) {
    return {
      uri,
      mimeType,
      text: buffer.toString('utf-8'),
    };
  }

  return {
    uri,
    mimeType,
    blob: buffer.toString('base64'),
  };
}

export function getAssetMimeType(fileName: string): string {
  const ext = path.extname(fileName).toLowerCase();
  return MIME_TYPES[ext] ?? 'application/octet-stream';
}

function sha256File(filePath: string): string {
  const hash = createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function sanitizeAssetFileName(fileName: string): string {
  const normalized = path.basename(fileName);
  if (!normalized || normalized === '.' || normalized === '..' || normalized !== fileName) {
    throw new Error(`Invalid asset name: ${fileName}`);
  }
  return normalized;
}

function isTextMimeType(mimeType: string): boolean {
  return mimeType.startsWith('text/')
    || mimeType === 'application/json'
    || mimeType === 'application/xml'
    || mimeType === 'application/yaml';
}
