// tsc does not copy .lua files, and the scripts are loaded from disk at
// startup, so the build step puts them next to the compiled output.
import { cp, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const from = fileURLToPath(new URL('../src/lua', import.meta.url));
const to = fileURLToPath(new URL('../dist/lua', import.meta.url));

await mkdir(to, { recursive: true });
await cp(from, to, { recursive: true });
