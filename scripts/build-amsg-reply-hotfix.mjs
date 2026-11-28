#!/usr/bin/env node
/**
 * Reproducible derivative of the reviewed 2026-11-26 AMSG artifact.
 *
 * The source commit claimed by that release is not currently available. This is
 * deliberately NOT a rebuild of worker/amsg/src (main has an older SDK/schema).
 * Only three reviewed, dependency-light source modules, the release version and
 * one capability field may change. Every other byte is copied from the pinned
 * artifact and recorded in the provenance manifest.
 *
 * Generate: node scripts/build-amsg-reply-hotfix.mjs
 * Verify:   node scripts/build-amsg-reply-hotfix.mjs --check
 * A sparse checkout may supply --base /path/to/the/unchanged/2026-11-26/artifact.
 * No network, deployment, dependency update or release-pin mutation occurs here.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';
import ts from 'typescript';

export const HOTFIX = Object.freeze({
  version: '2026-11-28',
  fileName: 'amsg-worker-2026-11-28.bundle.js',
  provenancePath: 'worker/amsg/releases/2026-11-28-reply-hotfix.provenance.json',
  baseFileName: 'amsg-worker-2026-11-26.bundle.js',
  baseSha256: 'e376c8e8db133332717757d7f11e191ad5cf6883c37eac9421fcbc8259e10359',
  baseRepositoryCommit: '5f9edaed2e5a078508f6ec8f031367399b60d51b',
  claimedUnavailableSourceCommit: 'e9252af6b295a3f67f22f9f911aaff4e8ba918f9',
  channel: 'lemuria-amsg',
  schemaProtocol: '3.2.0-lease-token',
  sdkVersion: '3.2.0-next.2',
  replyBoundaryVersion: 2,
});

const COMPILER_VERSIONS = Object.freeze({ esbuild: '0.21.5', typescript: '5.9.3' });
const MODULES = [
  {
    path: 'utils/replyBoundary.ts', next: 'utils/openAiStream.ts',
    originalSha256: '3d3d9674834e8b617465e43ce70e12e5f15d2d1d47346c88361cad62cb6f271d',
    sourceSha256: '6c8b1b1eab6eaa7a15878675da0015e26c4fe8c7cc640b28a442af3b69a5b95d',
    imports: {},
    exports: ['ReplyBoundaryError', 'finalizeReply', 'frameReplyMessages', 'isThoughtPart', 'publicMessageText', 'publicPartText', 'readReply'],
    declarations: ['ReplyBoundaryError', 'finalizeReply', 'frameReplyMessages', 'isThoughtPart', 'publicMessageText', 'publicPartText', 'readReply'],
  },
  {
    path: 'utils/openAiStream.ts', next: 'utils/characterTransport.ts',
    originalSha256: '02ca1a9613574e2642ae0fe7e86e2352bceb6b00f3419ec395033efc08d2afd9',
    sourceSha256: '6a7eba636430332126f0c9cc0be89d14b4f6ceb6f5475729ab75eba32a3f6234',
    imports: { './replyBoundary': ['isThoughtPart', 'publicMessageText'] },
    exports: ['SSE_FINISH_GRACE_MS', 'SseAssembler', 'isSseResponseText', 'parseSseToCompletion', 'readOpenAiResponse'],
    declarations: ['SSE_FINISH_GRACE_MS', 'SseAssembler', 'isSseResponseText', 'parseRawBodyText', 'parseSseToCompletion', 'readOpenAiResponse'],
  },
  {
    path: 'utils/characterTransport.ts', next: 'worker/amsg/src/instantInput.ts',
    originalSha256: '8d9f124763c43752858c3edf0d5a63d0786d09084bd16bd880f6db7a14886981',
    sourceSha256: 'c47b1969bae99a7da3f663352c3db29db16101e000522cc27b46c66fee86d5d0',
    imports: {
      './completionOutcome': ['assertCompletionDelivered'],
      './openAiStream': ['readOpenAiResponse'],
      './replyBoundary': ['ReplyBoundaryError', 'finalizeReply', 'frameReplyMessages'],
    },
    exports: ['characterTransport'], declarations: ['characterTransport'],
  },
];

export const sha256 = value => createHash('sha256').update(value).digest('hex');
const rootFromScript = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sameNames = (left, right) => JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
const insist = (condition, message) => { if (!condition) throw new Error(message); };

function oneIndex(text, needle, description) {
  const index = text.indexOf(needle);
  insist(index >= 0 && text.indexOf(needle, index + needle.length) === -1, `Expected exactly one ${description}`);
  return index;
}

function parseJavaScript(code, name) {
  const ast = ts.createSourceFile(name, code, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
  insist(ast.parseDiagnostics.length === 0, `JavaScript parse failure: ${name}`);
  return ast;
}

function topLevelNames(ast) {
  const names = [];
  const addBinding = node => {
    if (ts.isIdentifier(node)) names.push(node.text);
    else for (const element of node.elements ?? []) if (ts.isBindingElement(element)) addBinding(element.name);
  };
  for (const statement of ast.statements) {
    if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) {
      if (statement.name) names.push(statement.name.text);
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) addBinding(declaration.name);
    } else if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause;
      if (clause?.name) names.push(clause.name.text);
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        names.push(...clause.namedBindings.elements.map(element => element.name.text));
      }
    }
  }
  return names;
}

async function compileModule(root, spec) {
  const source = readFileSync(resolve(root, spec.path));
  insist(sha256(source) === spec.sourceSha256, `Reviewed source changed: ${spec.path}; review and update its explicit hash lock`);
  const transformed = await esbuild.transform(source.toString('utf8'), {
    loader: 'ts', target: 'es2022', format: 'esm', charset: 'ascii',
    minify: false, treeShaking: false, sourcemap: false, legalComments: 'inline',
  });
  const ast = parseJavaScript(transformed.code, spec.path);
  const removals = [];
  const actualImports = {};
  const actualExports = [];
  for (const statement of ast.statements) {
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause;
      insist(clause && !clause.name && clause.namedBindings && ts.isNamedImports(clause.namedBindings), `Unexpected import form: ${spec.path}`);
      const names = clause.namedBindings.elements.map(element => {
        insist(!element.propertyName || element.propertyName.text === element.name.text, `Renamed import in ${spec.path}`);
        return element.name.text;
      });
      const from = statement.moduleSpecifier.text;
      insist(!actualImports[from], `Repeated dependency in ${spec.path}`);
      actualImports[from] = names;
      removals.push([statement.getStart(ast), statement.end]);
    } else if (ts.isExportDeclaration(statement)) {
      insist(!statement.moduleSpecifier && statement.exportClause && ts.isNamedExports(statement.exportClause), `Unexpected export form: ${spec.path}`);
      for (const element of statement.exportClause.elements) {
        insist(!element.propertyName || element.propertyName.text === element.name.text, `Renamed export in ${spec.path}`);
        actualExports.push(element.name.text);
      }
      removals.push([statement.getStart(ast), statement.end]);
    }
  }
  insist(sameNames(Object.keys(actualImports), Object.keys(spec.imports)), `Dependency set changed: ${spec.path}`);
  for (const [from, names] of Object.entries(spec.imports)) {
    insist(sameNames(actualImports[from], names), `Dependency symbols changed: ${spec.path} -> ${from}`);
  }
  insist(sameNames(actualExports, spec.exports), `Export set changed: ${spec.path}`);
  let stripped = transformed.code;
  for (const [start, end] of removals.sort((a, b) => b[0] - a[0])) stripped = stripped.slice(0, start) + stripped.slice(end);
  stripped = stripped.trim() + '\n';
  const strippedAst = parseJavaScript(stripped, spec.path);
  insist(sameNames(topLevelNames(strippedAst), spec.declarations), `Top-level declarations changed: ${spec.path}`);
  insist(strippedAst.statements.every(statement => ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isVariableStatement(statement)), `Unexpected top-level side effect: ${spec.path}`);
  return { code: `// ${spec.path}\n${stripped}\n`, sourceSha256: sha256(source), imports: spec.imports, exports: spec.exports };
}

/** Does not write files. Exported so offline tests verify the actual generation. */
export async function buildHotfix(options = {}) {
  const root = options.root ?? rootFromScript;
  insist(esbuild.version === COMPILER_VERSIONS.esbuild && ts.version === COMPILER_VERSIONS.typescript, 'Compiler version mismatch; use the repository frozen lockfile');
  const basePath = options.basePath ?? resolve(root, 'public', HOTFIX.baseFileName);
  const base = readFileSync(basePath);
  insist(sha256(base) === HOTFIX.baseSha256, 'Base Worker SHA-256 mismatch; no output was written');
  const original = base.toString('utf8');
  insist(Buffer.from(original).equals(base), 'Base artifact is not lossless UTF-8');
  const edits = [];
  const modules = [];
  for (const spec of MODULES) {
    const start = oneIndex(original, `// ${spec.path}\n`, `${spec.path} module marker`);
    const end = oneIndex(original, `// ${spec.next}\n`, `${spec.next} module marker`);
    insist(end > start, `Module boundary order changed: ${spec.path}`);
    const oldBlock = original.slice(start, end);
    insist(sha256(oldBlock) === spec.originalSha256, `Original module changed: ${spec.path}`);
    const compiled = await compileModule(root, spec);
    edits.push({ name: spec.path, start, end, replacement: compiled.code });
    modules.push({ path: spec.path, originalBlockSha256: spec.originalSha256, sourceSha256: compiled.sourceSha256, replacementBlockSha256: sha256(compiled.code), imports: compiled.imports, exports: compiled.exports });
  }
  const oldVersion = 'var AMSG_BUNDLE_VERSION = "2026-11-26";';
  const versionStart = oneIndex(original, oldVersion, 'bundle version declaration');
  edits.push({ name: 'bundle-version', start: versionStart, end: versionStart + oldVersion.length, replacement: `var AMSG_BUNDLE_VERSION = "${HOTFIX.version}";` });
  const oldCapability = '          releaseChannel: "lemuria-amsg",\n          workerVersion: AMSG_BUNDLE_VERSION,';
  const capabilityStart = oneIndex(original, oldCapability, 'config-check release capability anchor');
  edits.push({ name: 'reply-boundary-capability', start: capabilityStart, end: capabilityStart + oldCapability.length, replacement: '          releaseChannel: "lemuria-amsg",\n          replyBoundaryVersion: 2,\n          workerVersion: AMSG_BUNDLE_VERSION,' });

  const pieces = [];
  const unchanged = [];
  const replacements = [];
  let baseCursor = 0, resultCursor = 0;
  for (const edit of edits.sort((a, b) => a.start - b.start)) {
    const start = Buffer.byteLength(original.slice(0, edit.start));
    const end = Buffer.byteLength(original.slice(0, edit.end));
    insist(start >= baseCursor, `Overlapping patch: ${edit.name}`);
    const retained = base.subarray(baseCursor, start);
    pieces.push(retained);
    if (retained.length) unchanged.push({ baseStart: baseCursor, resultStart: resultCursor, bytes: retained.length, sha256: sha256(retained) });
    resultCursor += retained.length;
    const bytes = Buffer.from(edit.replacement);
    pieces.push(bytes);
    replacements.push({ name: edit.name, baseStart: start, baseBytes: end - start, resultStart: resultCursor, resultBytes: bytes.length, beforeSha256: sha256(base.subarray(start, end)), afterSha256: sha256(bytes) });
    resultCursor += bytes.length;
    baseCursor = end;
  }
  const tail = base.subarray(baseCursor);
  pieces.push(tail);
  if (tail.length) unchanged.push({ baseStart: baseCursor, resultStart: resultCursor, bytes: tail.length, sha256: sha256(tail) });
  const bundle = Buffer.concat(pieces);
  const generated = bundle.toString('utf8');
  const names = topLevelNames(parseJavaScript(generated, HOTFIX.fileName));
  insist(new Set(names).size === names.length, 'Patched modules introduce a top-level symbol collision');
  for (const invariant of [
    'var SERVER_VERSION = true ? "3.2.0-next.2" : "0.0.0-dev";',
    'var SCHEMA_VERSION = "3.2.0-lease-token";',
    '          imageAuth: "owner-token",',
    '      onLLMOutput(ctx) {\n        if (!getKindFireStash(ctx.scratch) && !ctx.llmResponse?.lemuriaReplyVerified)',
  ]) {
    oneIndex(original, invariant, `base invariant ${invariant.split('\n')[0]}`);
    oneIndex(generated, invariant, `preserved invariant ${invariant.split('\n')[0]}`);
  }
  for (const part of unchanged) {
    insist(base.subarray(part.baseStart, part.baseStart + part.bytes).equals(bundle.subarray(part.resultStart, part.resultStart + part.bytes)), 'Unchanged-region byte check failed');
  }
  const manifest = {
    format: 'lemuria-amsg-artifact-derivative', formatVersion: 1,
    release: { version: HOTFIX.version, fileName: HOTFIX.fileName, sha256: sha256(bundle), bytes: bundle.length, channel: HOTFIX.channel, schemaProtocol: HOTFIX.schemaProtocol, sdkVersion: HOTFIX.sdkVersion, replyBoundaryVersion: HOTFIX.replyBoundaryVersion },
    base: { repository: 'chenhaohaot27-eng/SullyOS', repositoryCommit: HOTFIX.baseRepositoryCommit, fileName: HOTFIX.baseFileName, sha256: HOTFIX.baseSha256, bytes: base.length, claimedSourceCommit: HOTFIX.claimedUnavailableSourceCommit, fullSourceAvailable: false },
    build: { script: 'scripts/build-amsg-reply-hotfix.mjs', scriptSha256: sha256(readFileSync(resolve(root, 'scripts/build-amsg-reply-hotfix.mjs'))), compilers: COMPILER_VERSIONS, network: false, command: 'node scripts/build-amsg-reply-hotfix.mjs' },
    modules, replacements, unchangedRegions: unchanged,
    unchangedBytes: unchanged.reduce((sum, part) => sum + part.bytes, 0),
    limitations: [
      'Artifact derivative; not a recovered-source rebuild of the unavailable claimed release commit.',
      'SDK, D1 schema/migrations, lease handling, auth, secrets/bindings and Worker hooks are retained byte-for-byte outside the five listed replacements.',
      'Publishing the frontend pin does not update an existing Worker. Install this verified artifact or update its server AMSG_BUNDLE_URL and AMSG_BUNDLE_SHA256 before self-update.',
      'Offline fixtures do not attest the version installed on a user Worker or live provider behavior.',
    ],
  };
  return { bundle, manifest, base };
}

async function main() {
  const args = process.argv.slice(2);
  let check = false, basePath;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--check') check = true;
    else if (args[i] === '--base' && args[i + 1]) basePath = resolve(args[++i]);
    else throw new Error(`Unknown argument: ${args[i]}`);
  }
  const { bundle, manifest } = await buildHotfix({ basePath });
  const outputs = [
    [resolve(rootFromScript, 'public', HOTFIX.fileName), bundle],
    [resolve(rootFromScript, HOTFIX.provenancePath), Buffer.from(JSON.stringify(manifest, null, 2) + '\n')],
  ];
  if (check) {
    for (const [path, bytes] of outputs) insist(readFileSync(path).equals(bytes), `Generated artifact differs: ${path}`);
  } else {
    for (const [path, bytes] of outputs) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes); }
  }
  process.stdout.write(JSON.stringify({ checked: check, version: HOTFIX.version, sha256: manifest.release.sha256, bytes: bundle.length, unchangedBytes: manifest.unchangedBytes, replacements: manifest.replacements.length }) + '\n');
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
}
