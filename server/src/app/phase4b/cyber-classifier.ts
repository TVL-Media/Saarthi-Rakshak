// A small, explainable rule-based classifier for text a family chooses to share.
// Every flag has a category, a confidence and a plain explanation. It is a risk signal for a person
// to review, never a finding of fact. Low-confidence flags are labelled "uncertain".

export type CyberCategory = 'threat' | 'harassment' | 'humiliation' | 'coercion';
export type Confidence = 'high' | 'medium' | 'low';

export interface CyberFlag {
  category: CyberCategory;
  confidence: Confidence;
  explanation: string;
  excerpt: string;
}

interface Rule {
  category: CyberCategory;
  pattern: RegExp;
  weight: 'strong' | 'mild';
  why: string;
}

const RULES: Rule[] = [
  { category: 'threat', pattern: /\b(i('| a)?m going to|i will|i'll|gonna|we will|we'll)\s+(kill|hurt|beat|stab|shoot|attack|find)\s+(you|u)\b/i, weight: 'strong', why: 'Says the sender will hurt the reader.' },
  { category: 'threat', pattern: /\b(you'?re|you are|u r)\s+(dead|going to die)\b|\bwatch your back\b|\bi know where you live\b/i, weight: 'strong', why: 'Contains a threat or a warning of harm.' },
  { category: 'threat', pattern: /\b(kill|hurt|beat)\s+(yourself|urself)\b|\bkys\b|\bgo (die|kill yourself)\b/i, weight: 'strong', why: 'Tells the reader to harm themselves.' },
  { category: 'humiliation', pattern: /\b(ugly|stupid|idiot|loser|fat|dumb|worthless|pathetic|disgusting|freak)\b/i, weight: 'mild', why: 'Uses insulting words about a person.' },
  { category: 'humiliation', pattern: /\b(nobody|no one) (likes|wants|loves) you\b|\beveryone hates you\b|\bshould not exist\b/i, weight: 'strong', why: 'Tries to make the reader feel unwanted or ashamed.' },
  { category: 'humiliation', pattern: /\b(i will|i'll|we will|we'll|gonna)\s+(post|share|leak|send)\b.{0,40}\b(photo|pic|picture|video|chat|screenshot)s?\b/i, weight: 'strong', why: 'Threatens to share private images or chats.' },
  { category: 'coercion', pattern: /\b(send|show)\s+(me\s+)?(your\s+)?(nudes?|naked|private pics?|photos? without)\b/i, weight: 'strong', why: 'Asks for private or intimate images.' },
  { category: 'coercion', pattern: /\b(or else|or i will|if you don'?t.{0,30}i will)\b|\bdon'?t tell (anyone|anybody|your (mom|dad|parents))\b|\bkeep (this|it) (a )?secret\b/i, weight: 'strong', why: 'Pressures the reader or asks them to keep it secret.' },
  { category: 'coercion', pattern: /\bdo (it|what i say)\b.{0,20}\b(now|right now)\b|\byou have to\b/i, weight: 'mild', why: 'Uses pressure or demands.' },
  { category: 'harassment', pattern: /\b(leave me alone|stop (messaging|texting|calling)|stop following)\b/i, weight: 'mild', why: 'The reader is asking someone to stop contacting them.' },
];

/** Removes phone numbers, emails, links and long digit strings before anything is stored. */
export function redact(text: string): string {
  return text
    .replace(/https?:\/\/\S+|www\.\S+/gi, '[link removed]')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email removed]')
    .replace(/(\+?\d[\d\s().-]{7,}\d)/g, '[number removed]');
}

function excerptAround(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 40);
  const end = Math.min(text.length, index + length + 60);
  return `${start > 0 ? '…' : ''}${text.slice(start, end).trim()}${end < text.length ? '…' : ''}`;
}

export function classify(raw: string): CyberFlag[] {
  const text = redact(raw.trim());
  if (text.length === 0) return [];
  const byCategory = new Map<CyberCategory, { strong: number; mild: number; why: Set<string>; first: { i: number; len: number } }>();
  for (const rule of RULES) {
    const global = new RegExp(rule.pattern.source, rule.pattern.flags.includes('g') ? rule.pattern.flags : `${rule.pattern.flags}g`);
    for (const m of text.matchAll(global)) {
      const cur = byCategory.get(rule.category) ?? { strong: 0, mild: 0, why: new Set<string>(), first: { i: m.index ?? 0, len: m[0].length } };
      cur[rule.weight] += 1;
      cur.why.add(rule.why);
      byCategory.set(rule.category, cur);
    }
  }
  // Repeated insults, even mild ones, count as repeated harassment.
  const flags: CyberFlag[] = [];
  for (const [category, v] of byCategory) {
    let confidence: Confidence;
    if (v.strong >= 1) confidence = 'high';
    else if (v.mild >= 2) confidence = 'medium';
    else confidence = 'low';
    flags.push({
      category,
      confidence,
      explanation: `${[...v.why].join(' ')} Matched ${v.strong + v.mild} phrase(s).${confidence === 'low' ? ' Only one mild phrase, so this is uncertain.' : ''}`,
      excerpt: excerptAround(text, v.first.i, v.first.len).slice(0, 220),
    });
  }
  const mildCount = [...byCategory.values()].reduce((a, v) => a + v.mild, 0);
  if (mildCount >= 3 && !byCategory.has('harassment')) {
    flags.push({
      category: 'harassment',
      confidence: 'medium',
      explanation: `${mildCount} insulting or pressuring phrases appear in one message, which can be repeated harassment.`,
      excerpt: text.slice(0, 220),
    });
  }
  return flags;
}

export const isUncertain = (c: Confidence) => c === 'low';
