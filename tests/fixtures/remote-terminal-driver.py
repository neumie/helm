"""Owns only disposable PTYs started here; no desktop automation or existing terminal input."""
import fcntl
import json
import os
import pty
import select
import signal
import struct
import sys
import termios

root, node, pi_cli, repo, *mode_args = sys.argv[1:]
mode = mode_args[0] if mode_args else 'manual'
if mode not in ('automatic', 'manual', 'scoped'):
    raise ValueError('unsupported driver mode')
children = {}
screens = {}
try:
    for slot in ['a', 'b']:
        # Both disposable TUIs use one isolated HOME, just as ordinary Pi terminals
        # do, while their Pi roots remain separate so their sessions cannot merge.
        home = root
        agent = os.path.join(root, slot, 'agent')
        cwd = os.path.join(root, slot, 'cwd')
        os.makedirs(os.path.join(agent, 'extensions'), mode=0o700, exist_ok=True)
        os.makedirs(cwd, mode=0o700)
        # Manual proof intentionally begins without the bridge and hot-loads it
        # later. Automatic proof selects the actual bridge + questionnaire through
        # this disposable Pi global settings document, never operator settings.
        if mode == 'manual':
            with open(os.path.join(agent, 'settings.json'), 'w') as settings:
                json.dump({'extensions': [os.path.join(repo, 'packages/helm-ask-user-question/index.ts')]}, settings)
        elif not os.path.isfile(os.path.join(agent, 'settings.json')):
            raise ValueError('automatic proof requires installer-produced settings')
        env = {
            'HOME': home, 'PATH': os.path.dirname(node) + ':/usr/bin:/bin', 'TERM': 'xterm-256color',
            'LANG': 'en_US.UTF-8', 'PI_CODING_AGENT_DIR': agent,
            'PI_OFFLINE': '1', 'PI_TELEMETRY': '0', 'HELM_REMOTE_PROOF_ROOT': root,
            'HELM_REMOTE_PROOF_SLOT': slot,
        }
        if mode == 'scoped' and slot == 'a':
            env['HELM_REMOTE_DISABLE_AUTO'] = '1'
        pid, fd = pty.fork()
        if pid == 0:
            os.chdir(cwd)
            os.execve(node, [node, pi_cli, '--offline', '--no-approve', '--no-skills', '--no-context-files',
                '--no-prompt-templates', '--no-themes', '--no-builtin-tools',
                '-e', os.path.join(repo, 'tests/fixtures/remote-proof-provider.ts'),
                '--provider', 'remote-proof', '--model', 'deterministic'], env)
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 120, 0, 0))
        children[slot] = (pid, fd)
        screens[slot] = ''
    print(json.dumps({'ready': True, 'pids': {slot: value[0] for slot, value in children.items()}}), flush=True)
    pending = b''
    running = True
    while running:
        readable, _, _ = select.select([sys.stdin.fileno()] + [value[1] for value in children.values()], [], [], 1)
        for fd in readable:
            if fd == sys.stdin.fileno():
                chunk = os.read(fd, 65536)
                if not chunk:
                    running = False
                    break
                pending += chunk
                while b'\n' in pending:
                    line, pending = pending.split(b'\n', 1)
                    value = json.loads(line)
                    slot = value.get('slot', 'a')
                    if value['action'] == 'input':
                        os.write(children[slot][1], value['text'].encode())
                        result = {'ok': True}
                    elif value['action'] == 'screen':
                        result = {'screen': screens[slot]}
                    else:
                        raise ValueError('Unsupported driver action')
                    print(json.dumps({'id': value['id'], **result}), flush=True)
            else:
                slot = next(slot for slot, value in children.items() if value[1] == fd)
                try:
                    chunk = os.read(fd, 65536)
                    screens[slot] = (screens[slot] + chunk.decode(errors='replace'))[-200000:]
                except OSError:
                    running = False
                    break
finally:
    for pid, fd in children.values():
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        os.close(fd)
    for pid, _fd in children.values():
        try:
            os.waitpid(pid, 0)
        except ChildProcessError:
            pass
