let _cwd = process.cwd();

export function getCwd(): string {
  return _cwd;
}

export function setCwd(next: string): void {
  _cwd = next;
}
