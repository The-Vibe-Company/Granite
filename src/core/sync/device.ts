import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { v4 as uuidv4 } from 'uuid';

const DEVICE_FILE = 'device.json';

interface DeviceInfo {
  device_id: string;
  device_name: string;
  created: string;
}

function getDeviceFilePath(vaultRoot: string): string {
  const graniteDir = path.join(vaultRoot, '.granite');
  fs.mkdirSync(graniteDir, { recursive: true });
  return path.join(graniteDir, DEVICE_FILE);
}

export function getOrCreateDeviceId(vaultRoot: string, deviceName?: string): DeviceInfo {
  const filePath = getDeviceFilePath(vaultRoot);

  if (fs.existsSync(filePath)) {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as DeviceInfo;
  }

  const info: DeviceInfo = {
    device_id: uuidv4(),
    device_name: deviceName || os.hostname(),
    created: new Date().toISOString(),
  };

  fs.writeFileSync(filePath, JSON.stringify(info, null, 2), 'utf-8');
  return info;
}

export function getDeviceId(vaultRoot: string): string {
  return getOrCreateDeviceId(vaultRoot).device_id;
}
