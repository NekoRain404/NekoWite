// Conservative English spellchecker for the rendered pane.
//
// Strategy: a small built-in dictionary of common words (no external
// dependency) plus conservative rules that avoid false-positive bombs:
//   - only plain `[A-Za-z]+` tokens are considered (no CJK, digits, symbols)
//   - words shorter than 3 chars are ignored
//   - capitalized words (proper nouns / sentence starts) and ALL-CAPS
//     acronyms are skipped as likely intentional
//   - contractions split by the tokenizer (e.g. "doesn't" -> "doesn") are
//     covered by explicit dictionary entries for the common contraction stems
// Suggestions come from Levenshtein-distance neighbours within the dictionary.

export interface WordToken {
  word: string
  offset: number
}

export interface Misspelling {
  word: string
  offset: number
}

export interface MisspelledRange {
  word: string
  from: number
  to: number
}

const WORD_RE = /[A-Za-z]+/g

export function tokenize(text: string): WordToken[] {
  const tokens: WordToken[] = []
  let match: RegExpExecArray | null
  WORD_RE.lastIndex = 0
  while ((match = WORD_RE.exec(text)) !== null) {
    tokens.push({ word: match[0], offset: match.index })
  }
  return tokens
}

export function isMisspelled(word: string): boolean {
  if (!word) return false
  if (word.length < 3) return false
  if (!/^[A-Za-z]+$/.test(word)) return false
  // Proper nouns, acronyms and mixed-case tokens are treated as intentional.
  if (word !== word.toLowerCase()) return false
  return !DICTIONARY.has(word)
}

export function findMisspelled(content: string): Misspelling[] {
  return tokenize(content)
    .filter((token) => isMisspelled(token.word))
    .map((token) => ({ word: token.word, offset: token.offset }))
}

/** Apply `findMisspelled` to several text fragments, mapping token offsets
 *  into absolute character offsets. `base` is the character offset of the
 *  fragment's start within the enclosing text (typically a ProseMirror doc). */
export function findMisspelledRanges(
  nodes: Array<{ text: string; base: number }>,
): MisspelledRange[] {
  const out: MisspelledRange[] = []
  for (const node of nodes) {
    for (const { word, offset } of findMisspelled(node.text)) {
      out.push({ word, from: node.base + offset, to: node.base + offset + word.length })
    }
  }
  return out
}

export function suggestions(word: string, limit = 3): string[] {
  const lower = word.toLowerCase()
  const scored: Array<{ candidate: string; distance: number; prefix: number }> = []
  for (const candidate of DICTIONARY) {
    const distance = levenshtein(lower, candidate)
    if (distance > 2) continue
    let prefix = 0
    while (prefix < lower.length && prefix < candidate.length && lower[prefix] === candidate[prefix]) {
      prefix += 1
    }
    scored.push({ candidate, distance, prefix })
  }
  scored.sort((a, b) => a.distance - b.distance || b.prefix - a.prefix || a.candidate.length - b.candidate.length)
  return scored.slice(0, limit).map((s) => s.candidate)
}

function levenshtein(a: string, b: string): number {
  const m = a.length
  const n = b.length
  if (m === 0) return n
  if (n === 0) return m
  let prev = new Array<number>(n + 1)
  let curr = new Array<number>(n + 1)
  for (let j = 0; j <= n; j++) prev[j] = j
  for (let i = 1; i <= m; i++) {
    curr[0] = i
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost)
    }
    const swap = prev
    prev = curr
    curr = swap
  }
  return prev[n]
}

// A conservative set of ~400 common English words covering basic writing.
const DICTIONARY = new Set([
  // articles / pronouns / conjunctions / prepositions
  'the', 'a', 'an', 'and', 'or', 'but', 'so', 'yet', 'for', 'nor',
  'i', 'you', 'he', 'she', 'it', 'we', 'they', 'me', 'him', 'her', 'us', 'them',
  'my', 'your', 'his', 'its', 'our', 'their', 'mine', 'yours', 'ours', 'theirs',
  'this', 'that', 'these', 'those', 'who', 'whom', 'whose', 'which', 'what',
  'when', 'where', 'why', 'how', 'any', 'some', 'all', 'both', 'each', 'either',
  'every', 'few', 'many', 'most', 'much', 'neither', 'none', 'other', 'others',
  'several', 'such', 'to', 'of', 'in', 'on', 'at', 'by', 'with', 'about',
  'against', 'between', 'into', 'through', 'during', 'before', 'after', 'above',
  'below', 'from', 'up', 'down', 'out', 'off', 'over', 'under', 'again',
  'further', 'then', 'once', 'here', 'there', 'when', 'where', 'why', 'how',
  'not', 'no', 'yes', 'also', 'too', 'very', 'really', 'always', 'never',
  'often', 'sometimes', 'usually', 'now', 'later', 'today', 'yesterday',
  'tomorrow', 'only', 'just', 'still', 'already', 'yet', 'even', 'however',
  'therefore', 'though', 'although', 'while', 'because', 'since', 'unless',
  'until', 'whether', 'than', 'so', 'as',
  // modal & auxiliary verbs (+ common contraction stems)
  'am', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has',
  'had', 'having', 'do', 'does', 'did', 'doing', 'will', 'would', 'shall',
  'should', 'can', 'could', 'may', 'might', 'must', 'ought', 'need', 'dare',
  'doesn', 'didn', 'isn', 'aren', 'wasn', 'weren', 'hasn', 'haven', 'hadn',
  'couldn', 'wouldn', 'shouldn', 'won', 'shan', 'im', 'ive', 'id', 'ill',
  'youre', 'youve', 'youd', 'youll', 'hes', 'shes', 'its', 'weve', 'weve',
  'theyre', 'theyve', 'theyd', 'theyll',
  // common verbs
  'go', 'goes', 'going', 'went', 'gone', 'come', 'comes', 'coming', 'came',
  'make', 'makes', 'making', 'made', 'take', 'takes', 'taking', 'took',
  'taken', 'see', 'sees', 'seeing', 'saw', 'seen', 'know', 'knows', 'knowing',
  'knew', 'known', 'get', 'gets', 'getting', 'got', 'gotten', 'give', 'gives',
  'giving', 'gave', 'given', 'find', 'finds', 'finding', 'found', 'think',
  'thinks', 'thinking', 'thought', 'tell', 'tells', 'telling', 'told',
  'become', 'becomes', 'becoming', 'became', 'show', 'shows', 'showing',
  'showed', 'shown', 'leave', 'leaves', 'leaving', 'left', 'feel', 'feels',
  'feeling', 'felt', 'put', 'puts', 'putting', 'bring', 'brings', 'bringing',
  'brought', 'begin', 'begins', 'beginning', 'began', 'begun', 'keep', 'keeps',
  'keeping', 'kept', 'hold', 'holds', 'holding', 'held', 'write', 'writes',
  'writing', 'wrote', 'written', 'stand', 'stands', 'standing', 'stood',
  'hear', 'hears', 'hearing', 'heard', 'let', 'lets', 'letting', 'mean',
  'means', 'meaning', 'meant', 'set', 'sets', 'setting', 'meet', 'meets',
  'meeting', 'met', 'run', 'runs', 'running', 'ran', 'pay', 'pays', 'paying',
  'paid', 'sit', 'sits', 'sitting', 'sat', 'speak', 'speaks', 'speaking',
  'spoke', 'spoken', 'lie', 'lies', 'lying', 'lay', 'lain', 'lead', 'leads',
  'leading', 'led', 'read', 'reads', 'reading', 'understand', 'understands',
  'understood', 'watch', 'watches', 'watching', 'watched', 'follow', 'follows',
  'following', 'followed', 'stop', 'stops', 'stopping', 'stopped', 'create',
  'creates', 'creating', 'created', 'use', 'uses', 'using', 'used', 'work',
  'works', 'working', 'worked', 'need', 'needs', 'needing', 'needed', 'seem',
  'seems', 'seeming', 'seemed', 'help', 'helps', 'helping', 'helped', 'talk',
  'talks', 'talking', 'talked', 'turn', 'turns', 'turning', 'turned', 'start',
  'starts', 'starting', 'started', 'want', 'wants', 'wanting', 'wanted',
  'like', 'likes', 'liking', 'liked', 'love', 'loves', 'loving', 'loved',
  'call', 'calls', 'calling', 'called', 'ask', 'asks', 'asking', 'asked',
  'try', 'tries', 'trying', 'tried', 'need', 'look', 'looks', 'looking',
  'looked', 'live', 'lives', 'living', 'lived', 'believe', 'believes',
  'believing', 'believed', 'happen', 'happens', 'happening', 'happened',
  'include', 'includes', 'including', 'included', 'provide', 'provides',
  'providing', 'provided', 'consider', 'considers', 'considering', 'considered',
  'receive', 'receives', 'receiving', 'received', 'hello', 'hi', 'hey',
  'welcome', 'thanks', 'thank', 'please', 'sorry', 'goodbye', 'jump', 'jumps',
  'jumping', 'jumped', 'brown', 'fox', 'quick', 'lazy', 'dog', 'cat', 'over',
  'store', 'shopping', 'open', 'opens', 'opening', 'opened', 'close', 'closes',
  'closing', 'closed',
  // common nouns
  'time', 'year', 'day', 'week', 'month', 'hour', 'minute', 'second', 'way',
  'man', 'men', 'woman', 'women', 'child', 'children', 'person', 'people',
  'life', 'world', 'house', 'home', 'family', 'friend', 'father', 'mother',
  'brother', 'sister', 'son', 'daughter', 'name', 'place', 'school', 'work',
  'word', 'book', 'page', 'line', 'letter', 'story', 'idea', 'question',
  'answer', 'reason', 'part', 'thing', 'thing', 'number', 'money', 'water',
  'food', 'day', 'night', 'morning', 'evening', 'city', 'country', 'state',
  'government', 'group', 'team', 'company', 'problem', 'issue', 'hand', 'head',
  'eye', 'face', 'voice', 'room', 'door', 'window', 'car', 'road', 'street',
  'town', 'village', 'nature', 'history', 'future', 'present', 'past',
  'information', 'knowledge', 'thought', 'mind', 'heart', 'body', 'health',
  'music', 'movie', 'picture', 'image', 'computer', 'phone', 'email', 'internet',
  'website', 'system', 'program', 'software', 'data', 'game', 'sport', 'art',
  'science', 'language', 'word', 'meaning', 'example', 'change', 'chance',
  'course', 'class', 'lesson', 'teacher', 'student', 'doctor', 'work', 'job',
  'boss', 'office', 'meeting', 'project', 'plan', 'goal', 'dream', 'success',
  'failure', 'experience', 'moment', 'memory', 'feeling', 'emotion', 'love',
  'happiness', 'sadness', 'fear', 'hope', 'wish', 'purpose', 'reason', 'truth',
  'lie', 'rule', 'law', 'right', 'left', 'middle', 'top', 'bottom', 'side',
  'front', 'back', 'end', 'start', 'beginning', 'middle', 'point', 'level',
  'value', 'price', 'cost', 'result', 'effect', 'cause', 'action', 'activity',
  'event', 'fact', 'news', 'report', 'study', 'research', 'test', 'exam',
  'summer', 'winter', 'spring', 'fall', 'monday', 'tuesday', 'wednesday',
  'thursday', 'friday', 'saturday', 'sunday', 'january', 'february', 'march',
  'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november',
  'december',
  // common adjectives & adverbs
  'good', 'better', 'best', 'bad', 'worse', 'worst', 'new', 'old', 'young',
  'big', 'small', 'large', 'little', 'high', 'low', 'long', 'short', 'tall',
  'great', 'fine', 'nice', 'kind', 'happy', 'sad', 'angry', 'sure', 'clear',
  'true', 'false', 'easy', 'hard', 'difficult', 'simple', 'complex', 'fast',
  'slow', 'quick', 'slowly', 'quickly', 'early', 'late', 'soon', 'far', 'near',
  'close', 'open', 'right', 'wrong', 'important', 'different', 'same', 'similar',
  'special', 'real', 'whole', 'full', 'empty', 'free', 'busy', 'ready', 'done',
  'able', 'unable', 'possible', 'impossible', 'necessary', 'common', 'rare',
  'public', 'private', 'strong', 'weak', 'powerful', 'beautiful', 'pretty',
  'ugly', 'quiet', 'loud', 'silent', 'bright', 'dark', 'light', 'warm', 'cold',
  'hot', 'cool', 'fresh', 'clean', 'dirty', 'wet', 'dry', 'soft', 'hard',
  'sweet', 'bitter', 'smart', 'clever', 'funny', 'serious', 'careful',
  'careless', 'honest', 'friendly', 'strange', 'normal', 'usual', 'perfect',
  'wonderful', 'amazing', 'interesting', 'exciting', 'boring', 'terrible',
  'awful', 'dreadful',
  // numbers
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight',
  'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen',
  'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty', 'thirty', 'forty',
  'fifty', 'sixty', 'seventy', 'eighty', 'ninety', 'hundred', 'thousand',
  'million', 'billion', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth',
  'seventh', 'eighth', 'ninth', 'tenth', 'last', 'next', 'final',
])
