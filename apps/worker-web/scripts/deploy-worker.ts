#!/usr/bin/env node
/**
 * The release, under one `varlock run`: the site is built and the Worker bundled first (a failure
 * there touches nothing), then the D1 migrations are applied, then code goes up in one `wrangler
 * deploy` that also makes the custom domains match DOMAINS.
 *
 * Afterwards every Worker secret not in SECRET_KEYS is deleted over the API (wrangler's `secret
 * delete` is interactive only); there are none to keep, so any is stale. The deploy token reaches
 * wrangler as CLOUDFLARE_API_TOKEN for its own calls only, so it can never be mistaken for a
 * runtime secret.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import secretKeys from './secret-keys.json' with { type: 'json' };

/** The Worker's custom domains: a deploy attaches these and detaches any other. */
const DOMAINS = ['next.codetinder.dev'];

const SECRET_KEYS: readonly string[] = secretKeys;

const scriptsDir = fileURLToPath(new URL('.', import.meta.url));
const wrangler = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
const workerName = wrangler.match(/"name"\s*:\s*"([^"]+)"/)?.[1];
const accountId = wrangler.match(/"account_id"\s*:\s*"([^"]+)"/)?.[1];
const databaseName = wrangler.match(/"database_name"\s*:\s*"([^"]+)"/)?.[1];
const deployToken = process.env.CLOUDFLARE_DEPLOY_TOKEN;

if (!workerName || !accountId || !databaseName || !deployToken) {
  throw new Error(
    'Need "name", "account_id" and "database_name" in wrangler.jsonc and CLOUDFLARE_DEPLOY_TOKEN in the env.',
  );
}

const wranglerAs = (args: string[]) =>
  execFileSync('wrangler', args, {
    stdio: 'inherit',
    env: { ...process.env, CLOUDFLARE_API_TOKEN: deployToken, CI: 'true' },
  });

const cfSecrets = async (method: string, suffix = ''): Promise<{ name: string }[]> => {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${workerName}/secrets${suffix}`,
    { method, headers: { Authorization: `Bearer ${deployToken}` } },
  );
  const body = (await res.json()) as {
    success: boolean;
    errors?: unknown;
    result?: { name: string }[];
  };
  if (!body.success) {
    throw new Error(`Cloudflare API ${method} secrets${suffix}: ${JSON.stringify(body.errors)}`);
  }
  return body.result ?? [];
};

const tmp = mkdtempSync(join(tmpdir(), 'codetinder-deploy-'));
const secretsFile = join(tmp, 'secrets.json');
try {
  execFileSync('pnpm', ['-F', '@codetinder/site', 'build'], { stdio: 'inherit' });
  execFileSync('node', [join(scriptsDir, 'assemble-assets.ts')], { stdio: 'inherit' });
  execFileSync('node', [join(scriptsDir, 'resolve-secrets.ts'), secretsFile], { stdio: 'inherit' });
  wranglerAs(['deploy', '--dry-run', '--outdir', join(tmp, 'bundle')]);

  wranglerAs(['d1', 'migrations', 'apply', databaseName, '--remote']);
  // `--domains` makes DOMAINS the Worker's custom domains; as routes in wrangler.jsonc they would
  // also set the host `wrangler dev` answers as.
  wranglerAs([
    'deploy',
    '--secrets-file',
    secretsFile,
    ...DOMAINS.flatMap(domain => ['--domains', domain]),
  ]);

  const remote = await cfSecrets('GET');
  const stale = remote.map(secret => secret.name).filter(name => !SECRET_KEYS.includes(name));
  for (const name of stale) {
    console.log(`Pruning stale secret: ${name}`);
    await cfSecrets('DELETE', `/${name}`);
  }
  console.log(
    stale.length > 0
      ? `Reconciled — pruned ${stale.length} stale secret(s).`
      : 'Reconciled — nothing to prune.',
  );
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
