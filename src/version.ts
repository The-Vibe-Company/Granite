import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const GRANITE_VERSION = readPackageVersion();

function readPackageVersion(): string {
  const packageJsonPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../package.json');
  try {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8')) as { version?: unknown };
    if (typeof packageJson.version === 'string' && packageJson.version.length > 0) {
      return packageJson.version;
    }
  } catch {
    // Keep the CLI usable even if package metadata is unavailable in a dev build.
  }
  return '0.0.0';
}
