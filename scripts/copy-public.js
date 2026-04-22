const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const sourceDir = path.join(rootDir, 'public');
const targetDir = path.join(rootDir, 'dist', 'public');

if (!fs.existsSync(sourceDir)) {
  console.warn('[copy-public] No existe la carpeta public, se omite la copia.');
  process.exit(0);
}

fs.rmSync(targetDir, { recursive: true, force: true });
fs.mkdirSync(path.dirname(targetDir), { recursive: true });
fs.cpSync(sourceDir, targetDir, { recursive: true });

console.log(`[copy-public] Copiado ${sourceDir} -> ${targetDir}`);
