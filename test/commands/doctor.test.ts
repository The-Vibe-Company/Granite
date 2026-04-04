import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeDefaultConfig } from '../../src/core/config.js';
import { doctorCommand } from '../../src/commands/doctor.js';

describe('doctorCommand', () => {
  let tmpDir: string;
  let previousCwd: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'granite-doctor-cmd-'));
    previousCwd = process.cwd();
    process.chdir(tmpDir);
    writeDefaultConfig(tmpDir);
    fs.mkdirSync(path.join(tmpDir, 'notes', 'notes'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'notes', 'sources'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'notes', 'syntheses'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'notes', 'outputs'), { recursive: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.chdir(previousCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('prints json output when requested', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    doctorCommand({ json: true });

    expect(log).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(log.mock.calls[0][0] as string);
    expect(payload.success).toBe(true);
    expect(payload.data.healthy).toBe(true);
    expect(payload.data.counts).toEqual({ errors: 0, warnings: 0, infos: 0 });
  });
});
