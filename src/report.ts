/**
 * Problem reports are meant to be sent to someone else, so everything that identifies the person
 * or their machine is masked before it is shown: project folders, the home folder, the user and
 * host names, email addresses and anything shaped like an Anthropic key.
 */
export interface RedactOptions {
  home: string;
  username?: string;
  hostname?: string;
  /** Workspace folders; each becomes <workspace>, <workspace-2>… */
  folders?: string[];
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Both slash styles of a path, so "C:\Users\ana" and "C:/Users/ana" are masked alike. */
function pathPattern(p: string): RegExp {
  const parts = p.split(/[\\/]+/).filter(Boolean).map(escapeRegExp);
  const lead = /^[\\/]/.test(p) ? '[\\\\/]+' : '';
  return new RegExp(lead + parts.join('[\\\\/]+'), 'gi');
}

export function makeRedactor(opts: RedactOptions): (text: string) => string {
  const rules: [RegExp, string][] = [];
  const folders = [...(opts.folders ?? [])].filter((f) => f.length > 3).sort((a, b) => b.length - a.length);
  folders.forEach((f, i) => rules.push([pathPattern(f), i === 0 ? '<workspace>' : `<workspace-${i + 1}>`]));
  if (opts.home.length > 3) {
    rules.push([pathPattern(opts.home), '~']);
  }
  rules.push([/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>']);
  rules.push([/sk-ant-[A-Za-z0-9_-]+/g, '<key>']);
  if (opts.username && opts.username.length >= 3) {
    rules.push([new RegExp(`\\b${escapeRegExp(opts.username)}\\b`, 'gi'), '<user>']);
  }
  if (opts.hostname && opts.hostname.length >= 3) {
    rules.push([new RegExp(`\\b${escapeRegExp(opts.hostname)}\\b`, 'gi'), '<host>']);
  }
  return (text) => rules.reduce((s, [re, to]) => s.replace(re, to), text);
}
