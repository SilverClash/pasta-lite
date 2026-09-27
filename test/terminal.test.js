'use strict';
// src/terminal.js: which terminal commands are tried, and openTerminal over a fake spawn.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { terminalCommands, openTerminal, UNIX_TERMINALS } = require('../src/terminal');

test('terminalCommands: absolute argv per platform, the repo root as cwd, never a shell string', () => {
  const root = '/work/my repo; rm -rf ~';
  assert.deepEqual(terminalCommands('darwin', root), [{ cmd: '/usr/bin/open', args: ['-a', 'Terminal', root], cwd: root, wait: true }]);
  // Windows: cmd.exe from SystemRoot, never a bare name (looked up in the repo folder first).
  assert.deepEqual(terminalCommands('win32', root, { env: { SystemRoot: 'D:\\Win' } }),
    [{ cmd: 'D:\\Win\\System32\\cmd.exe', args: [], cwd: root, wait: false }]);
  for (const env of [{}, { SystemRoot: '' }, { SystemRoot: 'Windows' }, { SystemRoot: '.\\evil' }, { SystemRoot: '\\\\server\\share' }]) {
    assert.equal(terminalCommands('win32', root, { env })[0].cmd, 'C:\\Windows\\System32\\cmd.exe', JSON.stringify(env));
  }
  // Linux: resolved on PATH (absolute entries only); missing terminals are left out.
  const have = new Set(['/usr/bin/x-terminal-emulator', '/opt/t/bin/xterm', '/work/xterm']);
  const linux = terminalCommands('linux', root, { env: { PATH: ':.:rel/bin:/usr/bin:/opt/t/bin' }, isFile: (p) => have.has(p) });
  assert.deepEqual(linux, [
    { cmd: '/usr/bin/x-terminal-emulator', args: [], cwd: root, wait: false },
    { cmd: '/opt/t/bin/xterm', args: [], cwd: root, wait: false },
  ]);
  assert.deepEqual(terminalCommands('linux', root, { env: { PATH: '/nowhere' }, isFile: () => false }), []);
  for (const p of ['darwin', 'win32', 'linux']) {
    for (const c of terminalCommands(p, root, { env: { PATH: '/usr/bin' }, isFile: () => true })) {
      assert.ok((p === 'win32' ? path.win32 : path.posix).isAbsolute(c.cmd), `${p}: ${c.cmd}`);
    }
  }
  assert.throws(() => terminalCommands('darwin', 'relative/path'), /absolute/);
  assert.throws(() => terminalCommands('darwin', null), /absolute/);
});

/**
 * A fake spawn: `plan[cmd]` says what the child does: 'spawn' (started), 'exit:<code>' or
 * 'error'. Records [cmd, args, options] per call.
 */
function fakeSpawn(plan) {
  const calls = [];
  const spawn = (cmd, args, options) => {
    calls.push([cmd, args, options]);
    const child = new EventEmitter();
    child.unrefed = false;
    child.unref = () => { child.unrefed = true; };
    const what = plan[cmd] || 'error';
    setImmediate(() => {
      if (what === 'spawn') child.emit('spawn');
      else if (what.startsWith('exit:')) child.emit('exit', Number(what.slice(5)));
      else child.emit('error', new Error('ENOENT'));
    });
    spawn.children.push(child);
    return child;
  };
  spawn.calls = calls;
  spawn.children = [];
  return spawn;
}

test('openTerminal (macOS): waits for open to exit 0, never detached; a non-zero exit is no-terminal', async () => {
  const ok = fakeSpawn({ '/usr/bin/open': 'exit:0' });
  assert.equal(await openTerminal('/r/x', { spawn: ok, platform: 'darwin' }), true);
  assert.deepEqual(ok.calls, [['/usr/bin/open', ['-a', 'Terminal', '/r/x'], { cwd: '/r/x', detached: false, stdio: 'ignore', windowsHide: false }]]);
  const bad = fakeSpawn({ '/usr/bin/open': 'exit:1' });
  await assert.rejects(openTerminal('/r/x', { spawn: bad, platform: 'darwin' }), (e) => e.kind === 'no-terminal' && /exited with code 1/.test(e.message));
});

test('openTerminal (Linux): the first terminal that starts wins (detached, unref\'d); failures are collected', async () => {
  const env = { PATH: '/usr/bin' };
  const isFile = (p) => p === '/usr/bin/x-terminal-emulator' || p === '/usr/bin/xterm';
  const spawn = fakeSpawn({ '/usr/bin/xterm': 'spawn' });
  assert.equal(await openTerminal('/r/x', { spawn, platform: 'linux', env, isFile }), true);
  assert.deepEqual(spawn.calls.map((c) => c[0]), ['/usr/bin/x-terminal-emulator', '/usr/bin/xterm']);
  assert.equal(spawn.calls[1][2].detached, true);
  assert.equal(spawn.children[1].unrefed, true);
  const none = fakeSpawn({});
  await assert.rejects(openTerminal('/r/x', { spawn: none, platform: 'linux', env, isFile }),
    (e) => e.kind === 'no-terminal' && /x-terminal-emulator: ENOENT/.test(e.message) && /xterm: ENOENT/.test(e.message));
});

test('openTerminal: nothing on PATH is no-terminal without spawning; a relative root is refused', async () => {
  const spawn = fakeSpawn({});
  await assert.rejects(openTerminal('/r/x', { spawn, platform: 'linux', env: { PATH: '/nowhere' }, isFile: () => false }),
    (e) => e.kind === 'no-terminal' && e.message.includes(UNIX_TERMINALS.join(', ')));
  assert.equal(spawn.calls.length, 0);
  await assert.rejects(openTerminal('rel', { spawn, platform: 'darwin' }), /absolute/);
});

test('openTerminal (Windows): cmd.exe from SystemRoot, detached', async () => {
  const spawn = fakeSpawn({ 'D:\\Win\\System32\\cmd.exe': 'spawn' });
  assert.equal(await openTerminal('/r/x', { spawn, platform: 'win32', env: { SystemRoot: 'D:\\Win' } }), true);
  assert.equal(spawn.calls[0][2].detached, true);
});
