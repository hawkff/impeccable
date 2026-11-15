/**
 * Drives the Pi design-hook extension (skill/pi-extension/index.js) with a stub
 * extension API and a fake launcher that records what it was fed.
 * Run: node --test tests/pi-extension.test.mjs
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXTENSION = path.join(REPO_ROOT, 'skill/pi-extension/index.js');
const SKIP = process.platform === 'win32' ? 'fake launcher is a sh script' : false;

const FAKE_LAUNCHER = `#!/bin/sh
cat > "$FAKE_RECORD/stdin.json"
cat "$FAKE_RECORD/stdin.json" >> "$FAKE_RECORD/events.txt"
echo >> "$FAKE_RECORD/events.txt"
env > "$FAKE_RECORD/env.txt"
printf '%s' "$*" > "$FAKE_RECORD/argv.txt"
cat "$FAKE_RECORD/stdout.txt" 2>/dev/null
[ ! -f "$FAKE_RECORD/linger" ] || sleep 12 &
exit 0
`;

const POST = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'Gradient text in App.tsx' } });
const BLOCK = JSON.stringify({ decision: 'block', reason: 'Deep pass: 2 findings' });
const WROTE = [{ type: 'text', text: 'Successfully wrote to src/App.tsx' }];

let tmp;
let project;
let record;
let installed;
let bare;
let editedPath;

// Copies the extension where an install puts it, beside `skills/`, and imports the copy.
async function install(root) {
  const file = path.join(root, 'extensions/impeccable-design-hook/index.js');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.copyFileSync(EXTENSION, file);
  return import(pathToFileURL(file).href);
}

// Registers the extension on a stub API: fresh handlers with fresh per-run state.
function load(factory = installed) {
  const handlers = {};
  factory({ on: (name, handler) => { handlers[name] = handler; } });
  return handlers;
}

function ctx(overrides = {}) {
  return { cwd: project, signal: undefined, sessionManager: { getSessionId: () => 's1', getSessionFile: () => undefined }, ...overrides };
}

function toolResult(overrides = {}) {
  return { toolName: 'write', toolCallId: 'call-1', input: { path: 'src/App.tsx' }, content: WROTE, isError: false, ...overrides };
}

function settle(overrides = {}) {
  return { outcome: 'completed', entries: [], continue: false, ...overrides };
}

function stdout(text) {
  fs.writeFileSync(path.join(record, 'stdout.txt'), text);
}

function spawned() {
  return fs.existsSync(path.join(record, 'stdin.json'));
}

function sentEvent() {
  return JSON.parse(fs.readFileSync(path.join(record, 'stdin.json'), 'utf8'));
}

function sentEvents() {
  return fs.readFileSync(path.join(record, 'events.txt'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
}

describe('pi design-hook extension', { skip: SKIP }, () => {
  before(async () => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'impeccable-pi-extension-')));
    project = path.join(tmp, 'project');
    record = path.join(tmp, 'record');
    for (const dir of [project, record]) fs.mkdirSync(dir, { recursive: true });
    // The copies are ES modules wherever the temp dir sits.
    fs.writeFileSync(path.join(tmp, 'package.json'), '{"type":"module"}\n');
    const scripts = path.join(tmp, 'pi/skills/impeccable/scripts');
    fs.mkdirSync(scripts, { recursive: true });
    fs.writeFileSync(path.join(scripts, 'impeccable'), FAKE_LAUNCHER, { mode: 0o755 });
    ({ default: installed, editedPath } = await install(path.join(tmp, 'pi')));
    ({ default: bare } = await install(path.join(tmp, 'bare')));
    process.env.FAKE_RECORD = record;
  });

  beforeEach(() => {
    for (const name of ['stdin.json', 'events.txt', 'env.txt', 'argv.txt', 'stdout.txt', 'linger']) fs.rmSync(path.join(record, name), { force: true });
  });

  after(() => {
    delete process.env.FAKE_RECORD;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('registers the session, edit and turn-end handlers', () => {
    assert.deepEqual(Object.keys(load()).sort(), ['agent_before_settle', 'agent_settled', 'session_shutdown', 'session_start', 'tool_result']);
  });

  it('names its session to the shells Pi starts while it is loaded', async () => {
    const handlers = load();
    await handlers.session_start({ reason: 'startup' }, ctx());
    assert.equal(process.env.IMPECCABLE_PI_HOOK_SESSION, 's1');
    const other = ctx({ sessionManager: { getSessionId: () => 's2' } });
    await load().session_shutdown({ reason: 'quit' }, other);
    assert.equal(process.env.IMPECCABLE_PI_HOOK_SESSION, 's1', 'another session ending leaves this one named');
    await handlers.session_shutdown({ reason: 'reload' }, ctx());
    assert.equal(process.env.IMPECCABLE_PI_HOOK_SESSION, undefined);
    await load(bare).session_start({ reason: 'startup' }, ctx());
    assert.equal(process.env.IMPECCABLE_PI_HOOK_SESSION, undefined, 'no launcher, no hook to announce');
  });

  it('ignores tools other than write and edit', async () => {
    stdout(POST);
    assert.equal(await load().tool_result(toolResult({ toolName: 'read' }), ctx()), undefined);
    assert.equal(await load().tool_result(toolResult({ toolName: 'constructor' }), ctx()), undefined);
    assert.equal(spawned(), false);
  });

  it('leaves an error result and a call without a path untouched', async () => {
    stdout(POST);
    assert.equal(await load().tool_result(toolResult({ isError: true }), ctx()), undefined);
    assert.equal(await load().tool_result(toolResult({ input: {} }), ctx()), undefined);
    assert.equal(spawned(), false);
  });

  it('adds write findings to the result and sends a Claude-shaped Write event', async () => {
    stdout(POST);
    const out = await load().tool_result(toolResult(), ctx());
    assert.deepEqual(out, { content: [...WROTE, { type: 'text', text: 'Gradient text in App.tsx' }] });
    assert.deepEqual(sentEvent(), {
      hook_event_name: 'PostToolUse',
      cwd: project,
      session_id: 's1',
      tool_use_id: 'call-1',
      tool_name: 'Write',
      tool_input: { file_path: path.join(project, 'src/App.tsx') },
    });
    assert.equal(fs.readFileSync(path.join(record, 'argv.txt'), 'utf8'), 'hook');
    assert.match(fs.readFileSync(path.join(record, 'env.txt'), 'utf8'), /^IMPECCABLE_HOOK_HARNESS=pi$/m);
  });

  it('maps edit to Edit and keeps structured content', async () => {
    stdout(POST);
    const structuredContent = { replaced: 1 };
    const out = await load().tool_result(toolResult({ toolName: 'edit', structuredContent }), ctx());
    assert.deepEqual(out.structuredContent, structuredContent);
    assert.equal(sentEvent().tool_name, 'Edit');
  });

  it('resolves the path the way Pi tools do', async () => {
    stdout(POST);
    const sent = async (input) => {
      await load().tool_result(toolResult({ input: { path: input } }), ctx());
      return sentEvent().tool_input.file_path;
    };
    assert.equal(await sent('@src/styles.css'), path.join(project, 'src/styles.css'));
    assert.equal(await sent('src/a\u00A0b.css'), path.join(project, 'src/a b.css'));
    assert.equal(await sent('~/site/index.html'), path.join(os.homedir(), 'site/index.html'));
    assert.equal(await sent(path.join(tmp, 'elsewhere.css')), path.join(tmp, 'elsewhere.css'));
    assert.equal(await sent(pathToFileURL(path.join(tmp, 'a b.css')).href), path.join(tmp, 'a b.css'));
  });

  it('resolves the Windows spellings of a path the way Pi does there', () => {
    const cwd = 'C:\\repo';
    const resolved = (input) => editedPath(input, cwd, 'win32');
    assert.equal(resolved('src/App.tsx'), 'C:\\repo\\src\\App.tsx');
    assert.equal(resolved('/d/site/App.tsx'), 'D:\\site\\App.tsx');
    assert.equal(resolved('/mnt/c/site/a.css'), 'C:\\site\\a.css');
    assert.equal(resolved('/cygdrive/e'), 'E:\\');
    // Rooted, but no drive: Pi takes the drive of the process, not of the session cwd.
    assert.equal(resolved('/tmp/a.css'), path.win32.resolve('/tmp/a.css'));
    assert.equal(resolved('\\site\\a.css'), path.win32.resolve('\\site\\a.css'));
    assert.equal(resolved('~\\site\\a.css'), path.win32.resolve(path.win32.join(os.homedir(), 'site\\a.css')));
    assert.equal(resolved('file:///C:/site/a%20b.css'), 'C:\\site\\a b.css');
    assert.equal(editedPath('/d/site/App.tsx', '/repo', 'linux'), '/d/site/App.tsx', 'an ordinary path elsewhere');
  });

  it('returns nothing when the engine has nothing to say or answers with garbage', async () => {
    stdout('');
    assert.equal(await load().tool_result(toolResult(), ctx()), undefined);
    assert.equal(spawned(), true);
    stdout('not json');
    assert.equal(await load().tool_result(toolResult(), ctx()), undefined);
    stdout('"a string"');
    assert.equal(await load().tool_result(toolResult(), ctx()), undefined);
  });

  it('returns nothing once the run is aborted', async () => {
    stdout(POST);
    assert.equal(await load().tool_result(toolResult(), ctx({ signal: AbortSignal.abort() })), undefined);
  });

  // The launcher exits at once, but a process it started keeps its stdout open for 12s.
  it('stops waiting at the timeout when a leftover process holds the output open', async () => {
    stdout(POST);
    fs.writeFileSync(path.join(record, 'linger'), '');
    const started = Date.now();
    const out = await load().tool_result(toolResult(), ctx());
    assert.ok(Date.now() - started < 10000, 'waited for the leftover process');
    assert.equal(out.content[1].text, 'Gradient text in App.tsx', 'what the launcher printed still counts');
  });

  // No edit went through `write` or `edit` here: the Stop pass runs after every completed run.
  it('turns the Stop block decision into a message that keeps the run going', async () => {
    stdout(BLOCK);
    const earlier = { type: 'custom', customType: 'other-extension' };
    const out = await load().agent_before_settle(settle({ entries: [earlier] }), ctx());
    assert.deepEqual(out, {
      entries: [earlier, { type: 'custom_message', customType: 'impeccable-design-hook', content: 'Deep pass: 2 findings', display: true }],
      continue: true,
    });
    assert.deepEqual(sentEvent(), { hook_event_name: 'Stop', cwd: project, session_id: 's1', stop_hook_active: false });
  });

  it('accepts the additionalContext shape an older engine answers Stop with', async () => {
    stdout(JSON.stringify({ hookSpecificOutput: { hookEventName: 'Stop', additionalContext: 'Deep pass findings' } }));
    const out = await load().agent_before_settle(settle(), ctx());
    assert.equal(out.entries[0].content, 'Deep pass findings');
    assert.equal(out.continue, true);
  });

  it('lets the run settle on empty Stop output', async () => {
    stdout('');
    assert.equal(await load().agent_before_settle(settle(), ctx()), undefined);
    assert.equal(sentEvent().hook_event_name, 'Stop');
  });

  it('names the session file on Stop when the session has one', async () => {
    stdout('');
    const saved = ctx({ sessionManager: { getSessionId: () => 'named-by-hand', getSessionFile: () => '/sessions/named-by-hand.jsonl' } });
    await load().agent_before_settle(settle(), saved);
    assert.equal(sentEvent().transcript_path, '/sessions/named-by-hand.jsonl');
  });

  it('skips the Stop pass after an error or an abort', async () => {
    stdout(BLOCK);
    for (const outcome of ['error', 'aborted']) {
      assert.equal(await load().agent_before_settle(settle({ outcome }), ctx()), undefined);
    }
    assert.equal(spawned(), false);
  });

  it('marks the Stop hook active after it kept the run going, until the run settles', async () => {
    const handlers = load();
    stdout(BLOCK);
    await handlers.agent_before_settle(settle(), ctx());
    await handlers.agent_before_settle(settle(), ctx());
    await handlers.agent_settled({ aborted: false }, ctx());
    await handlers.agent_before_settle(settle(), ctx());
    assert.deepEqual(sentEvents().map(e => e.stop_hook_active), [false, true, false]);
  });

  it('stops continuing a run the engine keeps blocking', async () => {
    const handlers = load();
    stdout(BLOCK);
    const outs = [];
    for (let pass = 0; pass < 6; pass++) outs.push(await handlers.agent_before_settle(settle(), ctx()));
    assert.deepEqual(outs.map(out => out?.continue), [true, true, true, true, undefined, undefined]);
    assert.equal(sentEvents().length, 4, 'no Stop is sent once the cap is reached');
  });

  it('stands down when another copy already asked at this boundary', async () => {
    const handlers = load();
    stdout(BLOCK);
    const asked = { type: 'custom_message', customType: 'impeccable-design-hook', content: 'Deep pass: 2 findings', display: true };
    assert.equal(await handlers.agent_before_settle(settle({ entries: [asked] }), ctx()), undefined);
    assert.equal(spawned(), false);
    await handlers.agent_before_settle(settle(), ctx());
    assert.equal(sentEvent().stop_hook_active, true, 'the other copy kept the run going');
  });

  it('is a no-op where no skill is installed beside it', async () => {
    stdout(POST);
    const handlers = load(bare);
    assert.equal(await handlers.tool_result(toolResult(), ctx()), undefined);
    assert.equal(await handlers.agent_before_settle(settle(), ctx()), undefined);
    assert.equal(spawned(), false);
  });
});
