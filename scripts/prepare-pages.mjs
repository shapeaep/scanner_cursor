import { copyFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const distDir = path.resolve('dist');
const targetHint = process.argv[2]?.toLowerCase() || '';

const htmlFiles = (await readdir(distDir))
  .filter((fileName) => fileName.toLowerCase().endsWith('.html'))
  .sort((left, right) => {
    const leftLower = left.toLowerCase();
    const rightLower = right.toLowerCase();
    const leftPriority = targetHint && leftLower.includes(targetHint) ? 0 : 1;
    const rightPriority = targetHint && rightLower.includes(targetHint) ? 0 : 1;

    if (leftPriority !== rightPriority) {
      return leftPriority - rightPriority;
    }

    return left.localeCompare(right);
  });

if (htmlFiles.length === 0) {
  throw new Error('No HTML build output found in dist.');
}

const sourceHtmlPath = path.join(distDir, htmlFiles[0]);
const targetHtmlPath = path.join(distDir, 'index.html');

if (sourceHtmlPath !== targetHtmlPath) {
  await copyFile(sourceHtmlPath, targetHtmlPath);
}

console.log(`Prepared GitHub Pages entry: ${path.basename(sourceHtmlPath)} -> index.html`);
