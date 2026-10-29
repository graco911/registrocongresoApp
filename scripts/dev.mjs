import { spawn } from 'node:child_process';
import electron from 'electron';
await import('./build.mjs');
const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js'], { stdio: 'inherit' });
let app;
const stop = () => { vite.kill(); app?.kill(); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
let ready = false;
try {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (vite.exitCode !== null) throw new Error('Vite terminó antes de iniciar. Revisa el puerto 5173.');
    try {
      if ((await fetch('http://127.0.0.1:5173')).ok) { ready = true; break; }
    } catch (error) {
      if (attempt === 99) throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  if (!ready) throw new Error('El servidor de desarrollo no respondió correctamente.');
} catch (error) { stop(); throw error; }
app = spawn(electron, ['.'], {
  stdio: 'inherit', env: { ...process.env, CONGRESO_DEV: '1' },
});
app.on('exit', code => { vite.kill(); process.exit(code ?? 1); });
