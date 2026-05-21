import * as fs from 'fs';
import { createTwoFilesPatch } from 'diff';

export function computeDiff(filePath: string, newContent: string): string {
  const old = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : '';
  return createTwoFilesPatch(filePath, filePath, old, newContent, 'current', 'proposed');
}

export function colorDiff(patch: string): string {
  return patch.split('\n').map(line => {
    if (line.startsWith('+') && !line.startsWith('+++')) return '\x1b[32m' + line + '\x1b[0m';
    if (line.startsWith('-') && !line.startsWith('---')) return '\x1b[31m' + line + '\x1b[0m';
    if (line.startsWith('@@'))                            return '\x1b[36m' + line + '\x1b[0m';
    return '\x1b[90m' + line + '\x1b[0m';
  }).join('\n');
}
