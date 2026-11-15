/**
 * impeccable-design-hook: the Impeccable design detector as a Pi extension.
 *
 * Pi has no command-hook manifest, so this extension feeds the engine's `hook` verb the
 * Claude-shaped events it already understands: `tool_result` on `write` / `edit` sends a
 * PostToolUse event and adds the findings to the tool result, and `agent_before_settle`
 * sends a Stop event so the deep pass can keep the run going. The engine owns everything
 * else (UI-file filtering, `hook.enabled`, dedupe between the two passes).
 *
 * It runs the launcher of the impeccable skill installed beside it: `.pi/extensions/` goes
 * with `.pi/skills/`, and the agent dir's `extensions/` with its `skills/`. Pi loads a
 * project's extensions only once it trusts the project, the gate it puts on project skills
 * too. Fail-open: any error, timeout or missing launcher leaves Pi untouched.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CUSTOM_TYPE = 'impeccable-design-hook';
const TOOL_NAMES = new Map([['write', 'Write'], ['edit', 'Edit']]);
const EDIT_TIMEOUT_MS = 5000;
const STOP_TIMEOUT_MS = 30000;
// The most the engine asks for in one run: the deep pass, then three build-completion
// passes. Pi has no cap of its own, so a run never continues more often than this.
const MAX_CONTINUES = 4;
// Tells `impeccable context` which session a loaded extension serves. Pi exports the
// session of each shell it starts as PI_SESSION_ID, so the two differ in a session where
// this extension is installed but not loaded, and the manual detector stays on there.
const SESSION_ENV = 'IMPECCABLE_PI_HOOK_SESSION';
const WINDOWS = process.platform === 'win32';
const LAUNCHER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'skills', 'impeccable', 'scripts',
  WINDOWS ? 'impeccable.cmd' : 'impeccable');
// The spaces Pi's own tools fold to a plain one before they resolve a path.
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
// How Git Bash, MSYS, Cygwin and WSL spell a Windows drive: /c/, /cygdrive/c/, /mnt/c/.
const SHELL_DRIVE = /^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i;

/**
 * Runs `<launcher> hook` with `event` on stdin and gives back the object it printed, or
 * null. `timeout` bounds the wait itself, not only the launcher: a process the launcher
 * left behind can hold its stdout open long after it exited. On Windows the launcher runs
 * under a shell, and stopping it at the timeout or on abort stops that shell only: the
 * engine the shell started is left to finish its scan.
 */
function runHook(event, timeout, signal) {
  return new Promise((done) => {
    if (!existsSync(LAUNCHER)) return done(null);
    const options = {
      cwd: event.cwd,
      env: { ...process.env, IMPECCABLE_HOOK_HARNESS: 'pi' },
      signal,
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
    };
    try {
      // Node runs a .cmd file only through the shell, which takes the path quoted.
      const child = WINDOWS
        ? spawn(`"${LAUNCHER}" hook`, { ...options, shell: true })
        : spawn(LAUNCHER, ['hook'], options);
      let stdout = '';
      const finish = () => {
        clearTimeout(deadline);
        // Nothing more is read. Letting go of the pipe and the process keeps a leftover
        // process, or a launcher that ignores the signal, from holding Pi open.
        child.stdout.destroy();
        child.unref();
        try {
          const parsed = JSON.parse(stdout);
          done(parsed && typeof parsed === 'object' ? parsed : null);
        } catch {
          done(null);
        }
      };
      child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
      child.on('error', finish);
      child.on('close', finish);
      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify(event));
      const deadline = setTimeout(() => {
        child.kill();
        finish();
      }, timeout);
    } catch {
      done(null);
    }
  });
}

function additionalContext(output) {
  const text = output?.hookSpecificOutput?.additionalContext;
  return typeof text === 'string' ? text : '';
}

/**
 * The absolute path a `write` / `edit` call names, resolved the way Pi's tools resolve it
 * (`resolvePath` in Pi's utils/paths): a path resolved any other way names a file the
 * call did not write, and that edit goes unscanned.
 */
export function editedPath(input, cwd, platform = process.platform) {
  if (typeof input !== 'string' || !input) return null;
  const windows = platform === 'win32';
  const paths = windows ? path.win32 : path.posix;
  let file = input.replace(UNICODE_SPACES, ' ');
  if (file.startsWith('@')) file = file.slice(1);
  const drive = windows && !file.includes('\\') ? SHELL_DRIVE.exec(file) : null;
  if (drive) file = `${drive[1].toUpperCase()}:\\${(drive[2] ?? '').replaceAll('/', '\\')}`;
  if (file === '~') file = homedir();
  else if (file.startsWith('~/') || (windows && file.startsWith('~\\'))) file = paths.join(homedir(), file.slice(2));
  else if (file.startsWith('file://')) file = fileURLToPath(file, { windows });
  // A rooted Windows path with no drive takes the drive of the process, not of `cwd`.
  return paths.isAbsolute(file) ? paths.resolve(file) : paths.resolve(cwd, file);
}

/** @param {import('@earendil-works/pi-coding-agent').ExtensionAPI} pi */
export default function impeccableDesignHook(pi) {
  // How often the Stop pass has kept the current run going.
  let continues = 0;

  pi.on('session_start', (_event, ctx) => {
    if (existsSync(LAUNCHER)) process.env[SESSION_ENV] = ctx.sessionManager.getSessionId();
  });

  pi.on('session_shutdown', (_event, ctx) => {
    if (process.env[SESSION_ENV] === ctx.sessionManager.getSessionId()) delete process.env[SESSION_ENV];
  });

  pi.on('tool_result', async (event, ctx) => {
    const tool = TOOL_NAMES.get(event.toolName);
    const file = tool && !event.isError ? editedPath(event.input?.path, ctx.cwd) : null;
    if (!file) return;
    const text = additionalContext(await runHook({
      hook_event_name: 'PostToolUse',
      cwd: ctx.cwd,
      session_id: ctx.sessionManager.getSessionId(),
      // Names the call, so a project copy and an agent-dir copy of this extension scan it once.
      tool_use_id: event.toolCallId,
      tool_name: tool,
      tool_input: { file_path: file },
    }, EDIT_TIMEOUT_MS, ctx.signal));
    if (!text) return;
    return {
      content: [...event.content, { type: 'text', text }],
      // Pi drops structured content when content is replaced without it.
      ...(event.structuredContent === undefined ? {} : { structuredContent: event.structuredContent }),
    };
  });

  // Every completed run, not only one that edited: the engine also finds UI files a shell
  // command wrote, which never reach `tool_result` as an edit.
  pi.on('agent_before_settle', async (event, ctx) => {
    if (event.outcome !== 'completed' || continues >= MAX_CONTINUES) return;
    // Another copy of this extension already asked at this boundary.
    if (event.entries.some((entry) => entry.customType === CUSTOM_TYPE)) {
      continues += 1;
      return;
    }
    const sessionFile = ctx.sessionManager.getSessionFile();
    const output = await runHook({
      hook_event_name: 'Stop',
      cwd: ctx.cwd,
      session_id: ctx.sessionManager.getSessionId(),
      // Dates the session for the engine when its id does not: Pi's own ids carry their
      // creation time, an id given with `--session-id` need not.
      ...(sessionFile ? { transcript_path: sessionFile } : {}),
      // Tells the engine this run already continued for it, so it does not scan again.
      stop_hook_active: continues > 0,
    }, STOP_TIMEOUT_MS, ctx.signal);
    // Engines released before the pi harness answer Stop in the PostToolUse shape.
    const text = output?.decision === 'block' && typeof output.reason === 'string' ? output.reason : additionalContext(output);
    if (!text) return;
    continues += 1;
    return {
      entries: [...event.entries, { type: 'custom_message', customType: CUSTOM_TYPE, content: text, display: true }],
      continue: true,
    };
  });

  pi.on('agent_settled', () => {
    continues = 0;
  });
}
