import type { Skill } from '../lib/skills.js';

/**
 * Process-wide active skill set consulted by `SkillTool`'s getter.
 *
 * Daemon-setup writes the baseline (bundled + user + project) once at boot.
 * `runTurn` temporarily overlays per-agent skills for the duration of a turn
 * and restores the previous set in its finally block.
 *
 * Race caveat: concurrent turns on different channels share this global. The
 * worst case is one turn briefly sees another's skill overlay — tolerable
 * for current single-host/multi-channel setups. A proper async-local fix
 * lands later if multi-tenant pressure makes the race meaningful.
 */
let active: Skill[] = [];

export function setActiveSkills(skills: Skill[]): void {
  active = skills;
}

export function getActiveSkills(): Skill[] {
  return active;
}
