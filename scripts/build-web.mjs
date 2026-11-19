import fs from 'node:fs';
import path from 'node:path';

const srcDir = path.resolve('app/src/main/assets/web');
const distDir = path.resolve('dist');

fs.rmSync(distDir, { recursive: true, force: true });
fs.cpSync(srcDir, distDir, { recursive: true });

console.log(`Built offline web bundle into ${distDir}`);
