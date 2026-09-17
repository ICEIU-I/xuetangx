import { cpSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = new URL('../internal/webassets/assets/', import.meta.url);
mkdirSync(root, { recursive: true });
for (const name of readdirSync(root)) if (name !== '.gitkeep') rmSync(new URL(name, root), { recursive: true, force: true });
cpSync(fileURLToPath(new URL('../web/dist/', import.meta.url)), fileURLToPath(root), { recursive: true });
