// Markdown → ANSI renderer for assistant chat output.
//
// Why raw escape codes instead of `theme.ts` hex values: this output flows
// through Ink's <Text>{content}</Text> where Ink translates embedded ANSI
// sequences into its own styling. Ink's color prop only applies one color to
// the whole <Text> — to vary color within a line (e.g. bold inline code inside
// a heading), we need ANSI escapes embedded in the text content itself.

const C = {
  // Headings
  title:      '\x1b[1;38;5;105m',  // bold purple-leaning-blue
  subtitle:   '\x1b[1;38;5;177m',  // bold magenta
  h3:         '\x1b[38;5;177m',    // magenta, no bold

  // Inline
  bold:       '\x1b[1m',
  italic:     '\x1b[3m',
  strike:     '\x1b[9m',
  code:       '\x1b[38;5;215m',    // peach for inline code
  url:        '\x1b[2m',           // dim for parenthesized urls

  // Block structures
  bullet:     '\x1b[38;5;105m',    // matches title color
  codeBlock:  '\x1b[38;5;245m',    // muted grey for fenced code body
  border:     '\x1b[2m',           // dim border characters for fences/quotes/hr
  quote:      '\x1b[2;3m',         // dim italic for blockquote body

  reset:      '\x1b[0m',
};

const FENCE_RE  = /^```(\w*)\s*$/;
const H1_RE     = /^# (.*)$/;
const H2_RE     = /^## (.*)$/;
const H3_RE     = /^#{3,6} (.*)$/;
const UL_RE     = /^(\s*)[-*+] (.*)$/;
const OL_RE     = /^(\s*)(\d+)\. (.*)$/;
const HR_RE     = /^\s*(?:[-*_]\s*){3,}$/;
const QUOTE_RE  = /^>\s?(.*)$/;

const FENCE_WIDTH = 50;

function inlineFormat(s: string): string {
  const codeSlots: string[] = [];
  s = s.replace(/`([^`\n]+)`/g, (_, code: string) => {
    codeSlots.push(`${C.code}${code}${C.reset}`);
    return `\x00CODE${codeSlots.length - 1}\x00`;
  });

  s = s.replace(/\*\*(.+?)\*\*/g, `${C.bold}$1${C.reset}`);
  s = s.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, `${C.italic}$1${C.reset}`);
  s = s.replace(/(?<!_)_([^_\n]+)_(?!_)/g, `${C.italic}$1${C.reset}`);
  s = s.replace(/~~(.+?)~~/g, `${C.strike}$1${C.reset}`);
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text: string, url: string) =>
    `${C.bold}${text}${C.reset} ${C.url}(${url})${C.reset}`);

  s = s.replace(/\x00CODE(\d+)\x00/g, (_, i: string) => codeSlots[Number(i)]);
  return s;
}

export function renderMarkdown(md: string): string {
  const lines = md.split('\n');
  const out: string[] = [];

  let inFence = false;
  let fenceLang = '';

  for (const raw of lines) {
    const fence = raw.match(FENCE_RE);
    if (fence) {
      if (!inFence) {
        inFence = true;
        fenceLang = fence[1] || 'code';
        const tag = ` ${fenceLang} `;
        const rule = '─'.repeat(Math.max(0, FENCE_WIDTH - tag.length - 2));
        out.push(`${C.border}┌─${tag}${rule}${C.reset}`);
      } else {
        inFence = false;
        out.push(`${C.border}└${'─'.repeat(FENCE_WIDTH)}${C.reset}`);
      }
      continue;
    }

    if (inFence) {
      out.push(`${C.border}│${C.reset} ${C.codeBlock}${raw}${C.reset}`);
      continue;
    }

    if (HR_RE.test(raw)) {
      out.push(`${C.border}${'─'.repeat(FENCE_WIDTH)}${C.reset}`);
      continue;
    }

    const h1 = raw.match(H1_RE);
    if (h1) { out.push(`${C.title}▎ ${inlineFormat(h1[1])}${C.reset}`); continue; }

    const h2 = raw.match(H2_RE);
    if (h2) { out.push(`${C.subtitle}▎ ${inlineFormat(h2[1])}${C.reset}`); continue; }

    const h3 = raw.match(H3_RE);
    if (h3) { out.push(`${C.h3}${inlineFormat(h3[1])}${C.reset}`); continue; }

    const ul = raw.match(UL_RE);
    if (ul) {
      out.push(`${ul[1]}${C.bullet}●${C.reset} ${inlineFormat(ul[2])}`);
      continue;
    }

    const ol = raw.match(OL_RE);
    if (ol) {
      out.push(`${ol[1]}${C.bullet}${ol[2]}.${C.reset} ${inlineFormat(ol[3])}`);
      continue;
    }

    const q = raw.match(QUOTE_RE);
    if (q) {
      out.push(`${C.border}▏${C.reset} ${C.quote}${inlineFormat(q[1])}${C.reset}`);
      continue;
    }

    out.push(inlineFormat(raw));
  }

  if (inFence) out.push(`${C.border}└${'─'.repeat(FENCE_WIDTH)}${C.reset}`);

  return out.join('\n');
}
