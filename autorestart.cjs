const { spawn, execSync } = require('child_process');

let devProcess = null;
let botProcess = null;

function startAll() {
  console.log('🚀 [AUTORESTART] Iniciando serviços (Painel e Bot)...');
  
  const npmCmd = /^win/.test(process.platform) ? 'npm.cmd' : 'npm';
  
  devProcess = spawn(npmCmd, ['run', 'dev'], { stdio: 'inherit', shell: true });
  botProcess = spawn(npmCmd, ['run', 'bot'], { stdio: 'inherit', shell: true });
  
  devProcess.on('close', (code) => console.log(`⚠️ Dev server fechou com código ${code}`));
  botProcess.on('close', (code) => console.log(`⚠️ Bot fechou com código ${code}`));
}

function killTree(process) {
  if (!process) return;
  try {
    if (/^win/.test(require('os').platform())) {
      execSync(`taskkill /PID ${process.pid} /T /F`, { stdio: 'ignore' });
    } else {
      process.kill();
    }
  } catch (e) {}
}

function restartAll() {
  console.log('\n======================================================');
  console.log('🔄 [AUTORESTART] 2.5 horas passaram! Reiniciando tudo...');
  console.log('======================================================\n');
  
  killTree(devProcess);
  killTree(botProcess);
  
  setTimeout(startAll, 5000);
}

startAll();
setInterval(restartAll, 9000000);
