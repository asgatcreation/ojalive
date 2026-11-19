/**
 * Loading and running the Lua scripts.
 *
 * Each script is `prelude.lua` plus its own file, concatenated into one chunk,
 * so the helpers are shared without Redis supporting any notion of a library.
 *
 * Scripts are sent with `EVALSHA` — a 40-character hash instead of several
 * kilobytes of Lua on every bid — and fall back to `EVAL` on `NOSCRIPT`, which
 * is what happens after Redis restarts or someone runs `SCRIPT FLUSH`. The
 * fallback is not an error path we hope to avoid; it is the normal way a script
 * gets into a fresh Redis.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Redis } from 'ioredis';

export const SCRIPT_FILES = {
  placeBid: 'place-bid.lua',
  buyNow: 'buy-now.lua',
  closeLot: 'close-lot.lua',
  seedState: 'seed-state.lua',
} as const;

export type ScriptName = keyof typeof SCRIPT_FILES;

interface LoadedScript {
  readonly source: string;
  readonly sha: string;
}

export class ScriptError extends Error {}

/**
 * Read the scripts from disk and hash them.
 *
 * `import.meta.url` resolves to `src/lua` when running from source (tests, tsx)
 * and to `dist/lua` in a build, because the build step copies the directory.
 */
export async function loadScripts(): Promise<Map<ScriptName, LoadedScript>> {
  const dir = new URL('./lua/', import.meta.url);
  const prelude = await readFile(fileURLToPath(new URL('prelude.lua', dir)), 'utf8');

  const loaded = new Map<ScriptName, LoadedScript>();
  for (const [name, file] of Object.entries(SCRIPT_FILES) as Array<[ScriptName, string]>) {
    const body = await readFile(fileURLToPath(new URL(file, dir)), 'utf8');
    const source = `${prelude}\n-- ${file} ---------------------------------------\n${body}`;
    loaded.set(name, { source, sha: createHash('sha1').update(source).digest('hex') });
  }
  return loaded;
}

function isNoScript(error: unknown): boolean {
  return error instanceof Error && error.message.includes('NOSCRIPT');
}

export class ScriptRunner {
  private constructor(
    private readonly redis: Redis,
    private readonly scripts: Map<ScriptName, LoadedScript>,
  ) {}

  static async create(redis: Redis): Promise<ScriptRunner> {
    return new ScriptRunner(redis, await loadScripts());
  }

  /** The SHA Redis knows a script by. Exposed so tests can assert reuse. */
  sha(name: ScriptName): string {
    return this.script(name).sha;
  }

  /** Every script returns a JSON string; parsing belongs to the caller. */
  async run(name: ScriptName, keys: readonly string[], args: readonly string[]): Promise<string> {
    const script = this.script(name);
    try {
      return asString(await this.redis.evalsha(script.sha, keys.length, ...keys, ...args), name);
    } catch (error: unknown) {
      if (!isNoScript(error)) throw error;
      return asString(await this.redis.eval(script.source, keys.length, ...keys, ...args), name);
    }
  }

  private script(name: ScriptName): LoadedScript {
    const script = this.scripts.get(name);
    if (script === undefined) throw new ScriptError(`Unknown script: ${name}`);
    return script;
  }
}

function asString(value: unknown, name: ScriptName): string {
  if (typeof value !== 'string') {
    throw new ScriptError(`Script ${name} returned ${typeof value}, expected a JSON string`);
  }
  return value;
}
