import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FORBIDDEN_BASE64 = [
  'Zm9ybWFsLW5wYy10YWxpYQ==',
  'Zm9ybWFsLW5wYy1hbXVuZA==',
  'Zm9ybWFsLW5wYy1jaGFybGVz',
  'Zm9ybWFsLW5wYy1zdXRoZXJsYW5k',
  'W1N1bGx5T1MgRm9ybWFsIE5QQzo=',
  'Rk9STUFMX05QQ19ERUZJTklUSU9OUw==',
  'cHJvbW90ZUZvcm1hbE5wY3M=',
  'cHJvbW90ZWRfbnBj',
];

const SOURCE_DIRECTORIES = [
  'api', 'apps', 'assets', 'cloudflare', 'components', 'context', 'hooks', 'icons',
  'infra', 'netlify', 'pics', 'pixelroom', 'public', 'scripts', 'server', 'test', 'tools',
  'utils', 'worker',
];
const ROOT_INPUTS = [
  'App.tsx', 'constants.tsx', 'index.html', 'index.tsx', 'metadata.json', 'package.json',
  'vite.config.ts', 'vercel.json', 'wrangler.jsonc',
];
const TEXT_EXTENSIONS = new Set([
  '.cjs', '.css', '.html', '.js', '.json', '.jsx', '.map', '.mjs', '.svg', '.ts', '.tsx', '.txt', '.xml', '.yaml', '.yml',
]);

const collectTextFiles = (entry, result) => {
  if (!fs.existsSync(entry)) return;
  const stat = fs.statSync(entry);
  if (stat.isDirectory()) {
    for (const child of fs.readdirSync(entry)) collectTextFiles(path.join(entry, child), result);
    return;
  }
  if (TEXT_EXTENSIONS.has(path.extname(entry).toLowerCase())) result.push(entry);
};

export const scanPrivateNpcLeak = (root = process.cwd()) => {
  const files = [];
  for (const directory of SOURCE_DIRECTORIES) collectTextFiles(path.join(root, directory), files);
  for (const input of ROOT_INPUTS) collectTextFiles(path.join(root, input), files);
  collectTextFiles(path.join(root, 'dist'), files);

  const forbidden = FORBIDDEN_BASE64.map(value => Buffer.from(value, 'base64').toString('utf8'));
  const findings = [];
  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    for (const token of forbidden) {
      if (content.includes(token)) findings.push({ file: path.relative(root, file), token });
    }
  }
  return findings;
};

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const findings = scanPrivateNpcLeak();
  if (findings.length > 0) {
    console.error('Private NPC leak guard failed:');
    for (const finding of findings) console.error(`- ${finding.file}: ${JSON.stringify(finding.token)}`);
    process.exitCode = 1;
  } else {
    console.log('Private NPC leak guard passed.');
  }
}
