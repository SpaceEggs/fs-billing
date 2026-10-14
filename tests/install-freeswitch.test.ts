import { spawnSync } from 'node:child_process';
import { expect, test } from 'vitest';

const docker = spawnSync('docker', ['info'], { stdio: 'ignore' });

test.skipIf(!process.env.CI && docker.status !== 0)(
  'install.sh keeps FreeSWITCH stopped during and after package install',
  () => {
    const result = spawnSync(
      'docker',
      [
        'run',
        '--rm',
        '--network',
        'none',
        '-v',
        `${process.cwd()}:/repo:ro`,
        'debian:trixie',
        'bash',
        '/repo/freeswitch/tests/install_test.sh',
      ],
      { encoding: 'utf8' },
    );
    expect(result.stdout).toBe('install.sh service tests passed\n');
    expect(result.status).toBe(0);
  },
  180_000,
);
