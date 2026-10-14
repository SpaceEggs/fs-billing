import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { z } from 'zod';

const root = resolve(import.meta.dirname, '../../..');
if (existsSync(join(root, '.env'))) process.loadEnvFile(join(root, '.env'));
const artifactRoot = resolve(
  process.argv[2] ?? join(tmpdir(), `fs-billing-idor-evidence-${Date.now()}`),
);
const scratch = await mkdtemp(join(tmpdir(), 'fs-billing-idor-checkout-'));
const testFile = 'apps/api/src/idor.db.test.ts';
const portalFile = 'apps/api/src/routes/portal.ts';
const reportSchema = z.object({
  testResults: z.array(
    z.object({
      assertionResults: z.array(
        z.object({
          fullName: z.string(),
          status: z.string(),
          failureMessages: z.array(z.string()),
        }),
      ),
    }),
  ),
});
const proof: {
  lane: string;
  mutation: boolean;
  expectedFailure: boolean;
  passed: number;
  failed: number;
}[] = [];
await mkdir(artifactRoot, { recursive: true });
try {
  await cp(root, scratch, {
    recursive: true,
    filter: (source) =>
      source !== artifactRoot &&
      ![
        'node_modules',
        '.git',
        '.audit',
        '.aws',
        '.codex',
        '.agents',
        'artifacts',
        '.env',
      ].includes(basename(source)),
  });
  await symlink(
    join(root, 'node_modules'),
    join(scratch, 'node_modules'),
    'dir',
  );
  for (const directory of ['apps', 'packages']) {
    for (const workspace of await readdir(join(root, directory), {
      withFileTypes: true,
    })) {
      const modules = join(root, directory, workspace.name, 'node_modules');
      if (workspace.isDirectory() && existsSync(modules))
        await symlink(
          modules,
          join(scratch, directory, workspace.name, 'node_modules'),
          'dir',
        );
    }
  }
  const run = async (lane: 'app' | 'owner', mutation: boolean) => {
    const label = `${mutation ? 'mutation' : 'baseline'}-${lane}`;
    const directory = join(artifactRoot, label);
    await mkdir(directory, { recursive: true });
    const reportPath = join(directory, 'vitest.json');
    const child = spawnSync(
      process.execPath,
      [
        join(root, 'node_modules/vitest/vitest.mjs'),
        'run',
        '--config',
        'vitest.db.config.ts',
        testFile,
        '--reporter=json',
        `--outputFile=${reportPath}`,
      ],
      {
        cwd: scratch,
        env: {
          ...process.env,
          P4_IDOR_LANE: lane,
          P4_IDOR_ARTIFACT_DIR: directory,
        },
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
        timeout: 180_000,
      },
    );
    if (child.error) throw child.error;
    if (!existsSync(reportPath))
      throw new Error(`${label} produced no test report. ${child.stderr}`);
    const report = reportSchema.parse(
      JSON.parse(await readFile(reportPath, 'utf8')),
    );
    const assertions = report.testResults.flatMap(
      (result) => result.assertionResults,
    );
    const failures = assertions.filter(
      (assertion) => assertion.status === 'failed',
    );
    const expectLeak = mutation && lane === 'owner';
    if (expectLeak) {
      if (
        child.status !== 1 ||
        failures.length !== 1 ||
        assertions.some(
          (assertion) =>
            assertion.status !== 'passed' && assertion.status !== 'failed',
        ) ||
        !failures[0]?.fullName.includes(
          '[owner] live OpenAPI customer isolation portalContext positive behavior and A to B attack',
        ) ||
        !failures[0]?.failureMessages.some((message) =>
          message.includes('TENANT_FILTER_LEAK_ROWS:'),
        )
      )
        throw new Error(
          `${label} failed for something other than the expected tenant-balance leak. ${child.stdout}\n${child.stderr}`,
        );
    } else if (
      child.status !== 0 ||
      failures.length ||
      !assertions.length ||
      assertions.some((assertion) => assertion.status !== 'passed')
    )
      throw new Error(
        `${label} did not pass. ${child.stdout}\n${child.stderr}`,
      );
    proof.push({
      lane,
      mutation,
      expectedFailure: expectLeak,
      passed: assertions.filter((assertion) => assertion.status === 'passed')
        .length,
      failed: failures.length,
    });
    process.stdout.write(
      `${label}: ${expectLeak ? 'detected tenant balance leak' : 'all isolation assertions passed'}\n`,
    );
  };
  await run('app', false);
  await run('owner', false);
  const original = await readFile(join(scratch, portalFile), 'utf8');
  const filter =
    '.where(eq(schema.tenantBalances.tenantId, principal.tenantId))';
  if (original.split(filter).length !== 2)
    throw new Error('Expected exactly one portal tenant filter to mutate');
  const mutated = original.replace(filter, '');
  await writeFile(join(scratch, portalFile), mutated);
  await writeFile(
    join(artifactRoot, 'tenant-filter-mutation.diff'),
    `--- a/${portalFile}\n+++ b/${portalFile}\n-    ${filter}\n+\n`,
  );
  await run('owner', true);
  await run('app', true);
  await writeFile(
    join(artifactRoot, 'mutation-proof.json'),
    `${JSON.stringify({ mutation: 'remove portal balance tenant WHERE', sourceCheckoutUnchanged: true, proof }, null, 2)}\n`,
  );
  process.stdout.write(
    `IDOR double-defense proof passed. Evidence in ${artifactRoot}\n`,
  );
} finally {
  await rm(scratch, { recursive: true, force: true });
}
