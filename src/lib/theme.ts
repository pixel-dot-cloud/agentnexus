export interface Theme {
  primary:       string;
  deep:          string;
  subtle:        string;
  accent:        string;
  accentWarm:    string;
  text:          string;
  textDim:       string;
  success:       string;
  error:         string;
  warning:       string;
  diffAdd:       string;
  diffRemove:    string;
  planMode:      string;
  autoAccept:    string;
  bypass:        string;
  titleColor:    string;
  subtitleColor: string;
  codeColor:     string;
}

export type ThemeName = 'dark' | 'light';

export const DARK_THEME: Theme = {
  primary:       '#6B7FD7',
  deep:          '#4A5BC4',
  subtle:        '#8B96C8',
  accent:        '#FFE8D6',
  accentWarm:    '#F5C4A0',
  text:          '#E8E8F0',
  textDim:       '#9090A8',
  success:       '#5DB876',
  error:         '#E05C6C',
  warning:       '#D4A03A',
  diffAdd:       '#2A4A2E',
  diffRemove:    '#4A2228',
  planMode:      '#D4A03A',
  autoAccept:    '#5DB876',
  bypass:        '#E05C6C',
  titleColor:    '#7A6FD9',
  subtitleColor: '#D070C0',
  codeColor:     '#F5C088',
};

export const LIGHT_THEME: Theme = {
  primary:       '#4A5BC4',
  deep:          '#3347B0',
  subtle:        '#6B7FD7',
  accent:        '#FF8C42',
  accentWarm:    '#E67A30',
  text:          '#1A1A2A',
  textDim:       '#6060A0',
  success:       '#267A3A',
  error:         '#C0284A',
  warning:       '#9A6C10',
  diffAdd:       '#D4F0DC',
  diffRemove:    '#F0D4D8',
  planMode:      '#9A6C10',
  autoAccept:    '#267A3A',
  bypass:        '#C0284A',
  titleColor:    '#4A45A3',
  subtitleColor: '#9A4090',
  codeColor:     '#A86A28',
};

export const THEMES: Record<ThemeName, Theme> = {
  dark:  DARK_THEME,
  light: LIGHT_THEME,
};

let _current: ThemeName = 'dark';

export function getThemeName(): ThemeName { return _current; }
export function setThemeName(name: ThemeName): void { _current = name; }
export function getTheme(): Theme { return THEMES[_current]; }
