// Beneath the Mask — type display content (spec §5, §8.4).
// Nicknames + taglines + celebrities from the approved draft set.
// Blurbs authored for v1 (required by §5, missing from the draft table).
// Celebrities are community folklore attributions — always rendered with the
// UNOFFICIAL label. Avatars: original art (see /avatars), not 16personalities.

export type TypeCode =
  | 'INTJ' | 'INTP' | 'ENTJ' | 'ENTP'
  | 'INFJ' | 'INFP' | 'ENFJ' | 'ENFP'
  | 'ISTJ' | 'ISFJ' | 'ESTJ' | 'ESFJ'
  | 'ISTP' | 'ISFP' | 'ESTP' | 'ESFP';

export type Family = 'NT' | 'NF' | 'SJ' | 'SP';

export interface TypeContent {
  code: TypeCode;
  family: Family;
  nickname: string;
  tagline: string;
  blurb: string;
  celebrities: string[]; // always exactly 3
  /** family hue convention (avatars + UI accents). */
  hue: string;
  soft: string; // tinted background for cards
}

export const FAMILY_META: Record<Family, { label: string; hue: string; soft: string }> = {
  NT: { label: 'Analysts', hue: '#6F63B8', soft: '#ECEAF6' },
  NF: { label: 'Diplomats', hue: '#2E8B6E', soft: '#E4F2EC' },
  SJ: { label: 'Sentinels', hue: '#46586E', soft: '#E8EDF3' },
  SP: { label: 'Explorers', hue: '#D98E2B', soft: '#FBF0DD' },
};

export const TYPES: Record<TypeCode, TypeContent> = {
  INTJ: {
    code: 'INTJ', family: 'NT',
    nickname: 'The Mastermind',
    tagline: 'Had a 10-year plan by age 12. It worked.',
    blurb:
      'You have a spreadsheet for your five-year plan and a backup spreadsheet for the backup plan. People think you are plotting something — you are, and it is alarmingly efficient. Your friends suspect your love language is a well-formatted roadmap. They are not wrong.',
    celebrities: ['Nikola Tesla', 'Christopher Nolan', 'Isaac Newton'],
    hue: FAMILY_META.NT.hue, soft: FAMILY_META.NT.soft,
  },
  INTP: {
    code: 'INTP', family: 'NT',
    nickname: 'The Analyst',
    tagline: "Asks 'but why' recursively.",
    blurb:
      'You have 47 browser tabs open and every one of them is a question you fell into at 2 a.m. You have explained your brilliant system to people who nodded politely and understood none of it. The system remains brilliant. The laundry remains unfolded.',
    celebrities: ['Albert Einstein', 'Bill Gates', 'Charles Darwin'],
    hue: FAMILY_META.NT.hue, soft: FAMILY_META.NT.soft,
  },
  ENTJ: {
    code: 'ENTJ', family: 'NT',
    nickname: 'The General',
    tagline: 'Meetings end early when X arrives.',
    blurb:
      'You walked into this party and mentally restructured it within four minutes. Your rest state is a standing meeting and your hobby is efficiency. Somewhere behind the ambition there is a heart — it just calendarizes poorly.',
    celebrities: ['Steve Jobs', 'Margaret Thatcher', 'Gordon Ramsay'],
    hue: FAMILY_META.NT.hue, soft: FAMILY_META.NT.soft,
  },
  ENTP: {
    code: 'ENTP', family: 'NT',
    nickname: 'The Chaos Agent',
    tagline: 'Argues both sides. Wins both.',
    blurb:
      'You do not have opinions, you have a rotating exhibit of them. The group chat goes quiet when you say "hear me out" because everyone knows what follows. You have started four businesses, three arguments, and one fire — all as a bit.',
    celebrities: ['Leonardo da Vinci', 'Mark Twain', 'Thomas Edison'],
    hue: FAMILY_META.NT.hue, soft: FAMILY_META.NT.soft,
  },
  INFJ: {
    code: 'INFJ', family: 'NF',
    nickname: 'The Oracle',
    tagline: "Knew you'd say that.",
    blurb:
      'You understand everyone in the room better than they understand themselves, and you will take that to your grave. You have composed entire confrontations in your head — beautifully, diplomatically, silently. Nobody will ever know what you really think. That is rather the point.',
    celebrities: ['Nelson Mandela', 'Carl Jung', 'Lady Gaga'],
    hue: FAMILY_META.NF.hue, soft: FAMILY_META.NF.soft,
  },
  INFP: {
    code: 'INFP', family: 'NF',
    nickname: 'The Poet',
    tagline: 'Has feelings you will never be told about.',
    blurb:
      'You feel everything at full volume and mention none of it. Your playlist has songs that would emotionally dismantle the group chat, so the group chat will never hear them. You are either writing something tender or avoiding a phone call. Possibly both, probably forever.',
    celebrities: ['William Shakespeare', 'J.R.R. Tolkien', 'Kurt Cobain'],
    hue: FAMILY_META.NF.hue, soft: FAMILY_META.NF.soft,
  },
  ENFJ: {
    code: 'ENFJ', family: 'NF',
    nickname: 'The Anchor',
    tagline: "Everyone's emergency contact.",
    blurb:
      'You have never once been the drama and always somehow end up hosting the debrief. People leave conversations with you feeling understood, energized, and slightly reorganized. You give excellent advice you absolutely do not take.',
    celebrities: ['Martin Luther King Jr.', 'Oprah Winfrey', 'Barack Obama'],
    hue: FAMILY_META.NF.hue, soft: FAMILY_META.NF.soft,
  },
  ENFP: {
    code: 'ENFP', family: 'NF',
    nickname: 'The Spark',
    tagline: "Started this as a bit. Now it's a movement.",
    blurb:
      'You have the energy of a golden retriever and the follow-through of a weather forecast. Every plan you make is either the best night ever or forgotten by Thursday — sometimes both. Somehow, inexplicably, it always works out. Do not question the Spark.',
    celebrities: ['Robin Williams', 'Walt Disney', 'Robert Downey Jr.'],
    hue: FAMILY_META.NF.hue, soft: FAMILY_META.NF.soft,
  },
  ISTJ: {
    code: 'ISTJ', family: 'SJ',
    nickname: 'The Enforcer',
    tagline: 'The spreadsheet is law.',
    blurb:
      'You have never been late, never lost a receipt, and never once found "winging it" charming. The group relies on you completely and thanks you almost never. You notice. You have a file on it, tabbed and cross-referenced.',
    celebrities: ['Warren Buffett', 'George Washington', 'Angela Merkel'],
    hue: FAMILY_META.SJ.hue, soft: FAMILY_META.SJ.soft,
  },
  ISFJ: {
    code: 'ISFJ', family: 'SJ',
    nickname: 'The Guardian',
    tagline: 'Fixed it. Said nothing.',
    blurb:
      'You have quietly handled everyone\'s crisis this year and told exactly no one. Your love language is acts of service performed invisibly, like a very helpful ghost. You say "no worries" while absolutely keeping a mental ledger of worries.',
    celebrities: ['Mother Teresa', 'Beyoncé', 'Kate Middleton'],
    hue: FAMILY_META.SJ.hue, soft: FAMILY_META.SJ.soft,
  },
  ESTJ: {
    code: 'ESTJ', family: 'SJ',
    nickname: 'The Director',
    tagline: 'Has opinions. Shares all of them.',
    blurb:
      'You have a correct way to load a dishwasher and you are not afraid to say so. Rules are not restrictions to you; they are the load-bearing walls of civilization. Your friends roll their eyes and then quietly do it your way, because it works.',
    celebrities: ['Judge Judy', 'Martha Stewart', 'Kamala Harris'],
    hue: FAMILY_META.SJ.hue, soft: FAMILY_META.SJ.soft,
  },
  ESFJ: {
    code: 'ESFJ', family: 'SJ',
    nickname: 'The Host',
    tagline: 'The party IS X.',
    blurb:
      'You know everyone\'s dietary restrictions, birthdays, and current situations — and you check on all three. A room you are not in is technically just people standing near each other. You genuinely need everyone to be okay, which is exhausting and also why everyone loves you.',
    celebrities: ['Taylor Swift', 'Jennifer Lopez', 'Bill Clinton'],
    hue: FAMILY_META.SJ.hue, soft: FAMILY_META.SJ.soft,
  },
  ISTP: {
    code: 'ISTP', family: 'SP',
    nickname: 'The Mechanic',
    tagline: 'Speaks only when it matters.',
    blurb:
      'You have fixed the thing, understood the thing, and left the conversation about the thing — all in the time it took others to find the manual. Words are expensive for you; you spend them rarely and precisely. The toolbox is not a metaphor.',
    celebrities: ['Clint Eastwood', 'Michael Jordan', 'Bear Grylls'],
    hue: FAMILY_META.SP.hue, soft: FAMILY_META.SP.soft,
  },
    ISFP: {
    code: 'ISFP', family: 'SP',
    nickname: 'The Vibe',
    tagline: 'Quietly judging your playlist. Kindly.',
    blurb:
      'You move through the world on aesthetic principles no one is allowed to question because you will not be explaining them. Gentle on the surface, immovable underneath — like a river that has decided. Your "I’m fine" is a complete artistic statement.',
    celebrities: ['Michael Jackson', 'David Beckham', 'Lana Del Rey'],
    hue: FAMILY_META.SP.hue, soft: FAMILY_META.SP.soft,
  },
  ESTP: {
    code: 'ESTP', family: 'SP',
    nickname: 'The Daredevil',
    tagline: 'Said watch this — and you did.',
    blurb:
      'You have never met a risk you could not make sound reasonable in the moment. The group chat has one "is he okay?" story about you per month, minimum. You live at full throttle and your insurance premiums know it. Nobody has more fun. Statistically, nobody should.',
    celebrities: ['Madonna', 'Eddie Murphy', 'Bruce Willis'],
    hue: FAMILY_META.SP.hue, soft: FAMILY_META.SP.soft,
  },
  ESFP: {
    code: 'ESFP', family: 'SP',
    nickname: 'The Show',
    tagline: 'The reason the meeting ran long.',
    blurb:
      'You walked in and the lighting improved — that is simply a fact. Every story you tell has a encore, and every encore has a dance break. Underneath the spectacle is someone who genuinely feels everything and chooses joy anyway. The show must go on. It will. You will make sure of it.',
    celebrities: ['Elvis Presley', 'Jamie Foxx', 'Miley Cyrus'],
    hue: FAMILY_META.SP.hue, soft: FAMILY_META.SP.soft,
  },
};

export const TYPE_CODES = Object.keys(TYPES) as TypeCode[];

export function typeContent(code: string): TypeContent {
  const t = TYPES[code as TypeCode];
  if (!t) throw new Error(`unknown type code: ${code}`);
  return t;
}

/** Avatar path for a type + variant (sliced contact-sheet art). */
export function avatarSrc(code: string, variant: 'F' | 'M'): string {
  return `/avatars/${code}_${variant}.png`;
}

export const UNOFFICIAL_NOTE = 'Community attribution, unofficial — for fun.';
