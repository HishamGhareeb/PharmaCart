import { spawn } from 'node:child_process';

const children = ['infra/oidc/dev-server.ts', 'apps/api/src/server.ts'].map(path =>
  spawn(process.execPath, [path], { stdio: 'inherit', windowsHide: true }));
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of children) child.kill();
}
for (const child of children) {
  child.on('error', () => stop(1));
  child.on('exit', code => stop(code ?? 0));
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => stop());
