export type PermissionMode = 'default' | 'plan' | 'acceptEdits' | 'bypassPermissions';

export interface ModeConfig {
  title: string;
  label: string;
  color: () => string;
}

export const MODE_CONFIG: Record<PermissionMode, ModeConfig> = {
  default:           { title: 'Default',     label: 'DEFAULT',     color: () => '#888888' },
  plan:              { title: 'Plan Mode',    label: 'PLAN',        color: () => '#0088ff' },
  acceptEdits:       { title: 'Accept Edits', label: 'AUTO-ACCEPT', color: () => '#00ff88' },
  bypassPermissions: { title: 'Bypass Perms', label: 'BYPASS',      color: () => '#ff8800' },
};

export function getModeLabel(mode: PermissionMode): string {
  return MODE_CONFIG[mode]?.label ?? '';
}

export function getModeColor(mode: PermissionMode): string {
  return MODE_CONFIG[mode]?.color() ?? '#888888';
}

export function getModeTitle(mode: PermissionMode): string {
  return MODE_CONFIG[mode]?.title ?? 'Default';
}
