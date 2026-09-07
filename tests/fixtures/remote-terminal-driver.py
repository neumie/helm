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

root, node, pi_cli, repo = sys.argv[1:]
children = {}
screens = {}
try:
    for slot in ['a', 'b']:
        home = os.path.join(root, slot)
        os.makedirs(os.path.join(home, 'agent', 'extensions'), mode=0o700)
        env = {
            'HOME': home, 'PATH': os.path.dirname(node) + ':/usr/bin:/bin', 'TERM': 'xterm-256color',
            'LANG': 'en_US.UTF-8', 'PI_CODING_AGENT_DIR': os.path.join(home, 'agent'),
            'PI_OFFLINE': '1', 'PI_TELEMETRY': '0', 'HELM_REMOTE_PROOF_ROOT': root,
            'HELM_REMOTE_PROOF_SLOT': slot,
        }
        pid, fd = pty.fork()
        if pid == 0:
            os.chdir(home)
            os.execve(node, [node, pi_cli, '--offline', '--no-approve', '--no-skills', '--no-context-files',
                '--no-prompt-templates', '--no-themes', '--no-builtin-tools',
                '-e', os.path.join(repo, 'tests/fixtures/remote-proof-provider.ts'),
                '-e', os.path.join(repo, 'packages/helm-ask-user-question/index.ts'),
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
