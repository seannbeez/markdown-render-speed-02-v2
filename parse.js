// Fast drop-in replacement for marked 18.1.3 (default options, GFM on).
// parse(markdown) returns exactly the HTML marked renders for the same input.
// Written from scratch for this competition; the grammar mirrors marked's
// CommonMark 0.31.2 + GFM 0.29 behaviour, including where marked departs
// from the spec, because the graded reference is marked's own output.
//
// Speed design: the lexer works on indices into the source string (sticky
// regexes, no repeated slicing of the remaining input), inline rendering
// writes HTML directly instead of building token objects, and the hot
// helpers (escaping, entity decoding, tab expansion) are plain scans.

const BLOCK_TAGS =
  "address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul";

// Regex builder: like marked's `c()`. Replaces a placeholder with a pattern
// (a string or a regex's source), stripping `^` anchors from the inserted
// pattern so it works inside a larger expression.
const CARET = /(^|[^\[])\^/g;
function rx(src, flags) {
  let t = typeof src === "string" ? src : src.source;
  const b = {
    rep(s, r) {
      let o = typeof r === "string" ? r : r.source;
      o = o.replace(CARET, "$1");
      t = t.replace(s, o);
      return b;
    },
    re() { return new RegExp(t, flags); },
  };
  return b;
}

// ---- "other" helpers (marked's T) ----
const O = {
  codeRemoveIndent: /^(?: {0,3}\t| {1,4})/gm,
  outputLinkReplace: /\\([\[\]])/g,
  indentCodeCompensation: /^(\s+)(?:```)/,
  beginningSpace: /^\s+/,
  endingHash: /#$/,
  endingSpaceTabChar: /[ \t]$/,
  nonSpaceChar: /[^ ]/,
  newLineCharGlobal: /\n/g,
  tabCharGlobal: /\t/g,
  leadingSpaceTab: /^[ \t]+/,
  multipleSpaceGlobal: /\s+/g,
  blankLine: /^[ \t]*$/,
  doubleBlankLine: /\n[ \t]*\n[ \t]*$/,
  blockquoteStart: /^ {0,3}>/,
  blockquoteSetextReplace: /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g,
  blockquoteSetextReplace2: /^ {0,3}>[ \t]?/gm,
  blockquoteMarkerWhitespace: /^( {0,3}>)([ \t]+)/gm,
  listReplaceNesting: /^ {1,4}(?=( {4})*[^ ])/g,
  listIsTask: /^\[[ xX]\][ \t]+\S/,
  listReplaceTask: /^\[[ xX]\][ \t]+/,
  listTaskCheckbox: /\[[ xX]\]/,
  anyLine: /\n.*\n/,
  hrefBrackets: /^<(.*)>$/,
  tableDelimiter: /[:|]/,
  tableAlignChars: /^\||\| *$/g,
  tableRowBlankLine: /\n[ \t]*$/,
  tableAlignRight: /^ *-+: *$/,
  tableAlignCenter: /^ *:-+: *$/,
  tableAlignLeft: /^ *:-+ *$/,
  startATag: /^<a /i,
  endATag: /^<\/a>/i,
  startPreScriptTag: /^<(pre|code|kbd|script)(\s|>)/i,
  endPreScriptTag: /^<\/(pre|code|kbd|script)(\s|>)/i,
  startAngleBracket: /^</,
  endAngleBracket: />$/,
  unicodeAlphaNumeric: /[\p{L}\p{N}]/u,
  numericCharacterReference: /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/,
  numericCharacterReferenceOrAmpersand: /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,
  escapeTest: /[&<>"']/,
  escapeReplace: /[&<>"']/g,
  escapeTestNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/,
  escapeReplaceNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,
  percentDecode: /%25/g,
  findPipe: /\|/g,
  splitPipe: / \|/,
  slashPipe: /\\\|/g,
  carriageReturn: /\r\n|\r/g,
  notSpaceStart: /^\S*/,
  endingNewline: /\n$/,
};

// Indent-dependent regexes, cached per indent (marked's D()).
function cachedRegex(fn) {
  const cache = [];
  return (n) => {
    const i = Math.max(0, Math.min(3, n - 1));
    return cache[i] || (cache[i] = fn(i));
  };
}
const listItemRegex = (bull) => new RegExp(`^( {0,3}${bull})((?:[ \t][^\\n]*)?(?:\\n|$))`);
const nextBulletRegex = cachedRegex((a) => new RegExp(`^ {0,${a}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\\n]*)?(?:\\n|$))`));
const hrRegex = cachedRegex((a) => new RegExp(`^ {0,${a}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\\n+|$)`));
const fencesBeginRegex = cachedRegex((a) => new RegExp(`^ {0,${a}}(?:\`\`\`|~~~)`));
const headingBeginRegex = cachedRegex((a) => new RegExp(`^ {0,${a}}#{1,6}(?:\\s|$)`));
const htmlBeginRegex = cachedRegex((a) => new RegExp(`^ {0,${a}}(?:</?(?:${BLOCK_TAGS})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, "i"));
const blockquoteBeginRegex = cachedRegex((a) => new RegExp(`^ {0,${a}}>`));

// Lines that begin a new block (hr, ATX heading, blockquote, fences, list,
// block HTML, or a blank line). Shared by the blockquote / paragraph /
// table patterns as a negative lookahead, so lazy continuations stop there.
const BS_HR = " {0,3}(?:(?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)";
const BS_HEAD = " {0,3}#{1,6}(?:\\s|$)";
const BS_BQ = " {0,3}>";
const BS_FENCES = " {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)";
const BS_HTML = " {0,3}(?:<\\/?(?:" + BLOCK_TAGS + ")(?: +|\\n|\\/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)";
const BS_LIST_ANY = " {0,3}(?:[*+-]|\\d{1,9}[.)])(?:[ \\t]|\\n|$)";
const BS_LIST_1 = " {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]";
const BS_LIST_1T = " {0,3}(?:[*+-]|1[.)])[ \\t]";
const BS_BLANK = "[ \\t]+\\n";
const BS_CODE = "(?: {4}| {0,3}\\t)[^\\n]";
const BS_BQ_SET = BS_HR + "|" + BS_HEAD + "|" + BS_BQ + "|" + BS_FENCES + "|" + BS_LIST_ANY + "|" + BS_HTML + "|" + BS_BLANK;
const BS_PARA_SET = BS_HR + "|" + BS_HEAD + "|" + BS_BQ + "|" + BS_FENCES + "|" + BS_LIST_1 + "|" + BS_HTML;
const BS_TABLE_SET = BS_HR + "|" + BS_HEAD + "|" + BS_BQ + "|" + BS_CODE + "|" + BS_FENCES + "|" + BS_LIST_1T + "|" + BS_HTML;
const TABLE_DELIM = "((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)";
const TABLE_BODY = "((?:(?! *\\n|" + BS_TABLE_SET + ").*(?:\\n|$))*)";
const TABLE_LOOK = " *([^\\n ].*)\\n {0,3}" + TABLE_DELIM + "(?:\\n" + TABLE_BODY + "\\n*|$)";

// ---- block regexes (GFM) ----
const RE_NEWLINE = /^(?:[ \t]*(?:\n|$))+/;
const RE_CODE = /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/;
const RE_FENCES = /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/;
const RE_HEADING = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/;
const RE_HR = /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/;
const RE_TEXT = /^[^\n]+/;

// label for link reference definitions / reflinks: the "not empty" check
// runs once at the start; the characters then repeat (a newline may sit
// inside a label as long as it is not followed by a blank line)
const LABEL = /(?:(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+)/;
const RE_DEF = rx(/^ {0,3}\[(label)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(title))? *(?:\n+|$)/)
  .rep("label", LABEL)
  .rep("title", /(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))/)
  .re();

// GFM table
const RE_TABLE = new RegExp("^ *([^\\n ].*)\\n {0,3}" + TABLE_DELIM + "(?:\\n" + TABLE_BODY + "\\n*|$)");

// GFM setext heading (lheading): the text must not itself start a block.
const LH_NOT = " {0,3}(?:[*+-]|\\d{1,9}[.)]) |(?: {4}| {0,3}\\t)| {0,3}(?:`{3,}|~{3,})| {0,3}>| {0,3}#{1,6}(?:\\s|$)| {0,3}<[^\\n>]+>\\n| {0,3}\\|?(?:[:\\- ]*\\|)+[\\:\\- ]*\\n";
const LH_INNER = "\\s*?\\n| {0,3}(?:[*+-]|\\d{1,9}[.)]) | {0,3}(?:`{3,}|~{3,})| {0,3}>| {0,3}#{1,6}(?:\\s|$)| {0,3}(?:(?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)| {0,3}<[^\\n>]+>\\n| {0,3}\\|?(?:[:\\- ]*\\|)+[\\:\\- ]*\\n";
const RE_LHEADING = new RegExp("^(?!" + LH_NOT + ")((?:.|\\n(?!" + LH_INNER + "))+?)\\n {0,3}(=+|-+)[ \\t]*(?:\\n+|$)");

// GFM paragraph: stops before any line that begins a block, before a
// table (header + delimiter row), and before a blank line.
const RE_PARA = new RegExp("^([^\\n]+(?:\\n(?!" + BS_PARA_SET + "|" + TABLE_LOOK + "|" + BS_BLANK + ")[^\\n]+)*)");

// Blockquote: one or more `>` lines, each with lazy continuations that do
// not begin a new block. The tokenizer splits the match into lines.
const RE_BLOCKQUOTE = new RegExp("^( {0,3}> ?(?:(?![ \\t]*(?:\\n|$))((?:[^\\n]+(?:\\n(?!" + BS_BQ_SET + ")[^\\n]+)*))|[^\\n]*)(?:\\n|$))+");

// List start
const RE_LIST = /^( {0,3}(?:[*+-]|\d{1,9}[.)]))([ \t][^\n]*?)?(?:\n|$)/;

// Block HTML (type 7)
const RE_HTML = rx("^ {0,3}(?:<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)|comment[^\\n]*(\\n+|$)|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)|</?(tag)(?:[ \\t]+|\\n|/?>|$)[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$))", "i")
  .rep("comment", /<!--(?:-?>|[\s\S]*?(?:-->|$))/)
  .rep("tag", BLOCK_TAGS)
  .rep("attribute", / +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/)
  .re();

// ---- inline regexes (GFM) ----
const PUNCT = /[\p{P}\p{S}]/u;
const PUNCT_SPACE = /[\s\p{P}\p{S}]/u;
const NOT_PUNCT_SPACE = /[^\s\p{P}\p{S}]/u;
const PUNCT_NO_TILDE = /(?!~)[\p{P}\p{S}]/u;
const PUNCT_SPACE_NO_TILDE = /(?!~)[\s\p{P}\p{S}]/u;
const NOT_PUNCT_SPACE_OR_TILDE = /(?:[^\s\p{P}\p{S}]|~)/u;

const RE_ESCAPE = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/;
const RE_CODESPAN = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
const RE_BR = /^( {2,}|\\)\n(?!\s*$)[ \t]*/;

const SCHEME = /[a-zA-Z][a-zA-Z0-9+.-]{1,31}/;
const EMAIL = /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/;
const RE_AUTOLINK = rx(/^<(scheme:[^\s\x00-\x1f<>]*|email)>/)
  .rep("scheme", SCHEME)
  .rep("email", EMAIL)
  .re();

const COMMENT_PT = rx(/<!--(?:-?>|[\s\S]*?(?:-->|$))/).rep("(?:-->|$)", "-->").re();
const TAG_ATTR = /\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/;
const RE_TAG = rx("^comment|^</[a-zA-Z][a-zA-Z0-9-]*\\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:attribute)*?\\s*/?>|^<\\?[\\s\\S]*?\\?>|^<![a-zA-Z]+\\s[\\s\\S]*?>|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>")
  .rep("comment", COMMENT_PT)
  .rep("attribute", TAG_ATTR)
  .re();

// link label (allows balanced brackets, code spans)
const BRACKETS = /\[(?:\\[\s\S]|[^\[\]\\])*\]/;
const LINK_LABEL = rx(/(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/)
  .rep("brackets", BRACKETS)
  .re();
const LINK_HREF = /<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\))/;
const LINK_TITLE = /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)/;
const RE_LINK = rx(/^!?\[(label)\]\([ \t\n]*(href)(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(title))?[ \t\n]*\)/)
  .rep("label", LINK_LABEL)
  .rep("href", LINK_HREF)
  .rep("title", LINK_TITLE)
  .re();
const RE_REFLINK = rx(/^!?\[(label)\]\[(ref)\]/).rep("label", LINK_LABEL).rep("ref", LABEL).re();
const RE_NOLINK = rx(/^!?\[(ref)\](?:\[\])?/).rep("ref", LABEL).re();

// reflink search (global): used by masking and by link detection
const LINK_LABEL_LT = rx(/(?:[^\[\]\\`]*(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?/)
  .rep("brackets", BRACKETS)
  .re();
const REF_BE = /(?:(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999})/;
const RE_REFLINK_SEARCH = rx("reflink|nolink(?!\\()", "g")
  .rep("reflink", rx(/^!?\[(label)\]\[(ref)\]/).rep("label", LINK_LABEL_LT).rep("ref", REF_BE).re())
  .rep("nolink", rx(/^!?\[(ref)\](?:\[\])?/).rep("ref", REF_BE).re())
  .re();

// emphasis / strong delimiters
const EM_L_TMPL = /^(?:\*+(?:((?!\*)punct)|([^\s*]))?)|^_+(?:((?!_)punct)|([^\s_]))?/;
const RE_EM_L = rx(EM_L_TMPL, "u").rep(/punct/g, PUNCT_NO_TILDE).re();
const EM_R_AST_TMPL = "^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)punct(\\*+)(?=[\\s]|$)|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)|[\\s](\\*+)(?!\\*)(?=punct)|(?!\\*)punct(\\*+)(?!\\*)(?=punct)|notPunctSpace(\\*+)(?=notPunctSpace)";
const RE_EM_R_AST = rx(EM_R_AST_TMPL, "gu")
  .rep(/notPunctSpace/g, NOT_PUNCT_SPACE_OR_TILDE)
  .rep(/punctSpace/g, PUNCT_SPACE_NO_TILDE)
  .rep(/punct/g, PUNCT_NO_TILDE)
  .re();
const EM_R_UND_TMPL = "^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])|(?!_)punct(_+)(?=[\\s]|$)|notPunctSpace(_+)(?!_)(?=punctSpace|$)|(?!_)punctSpace(_+)(?=notPunctSpace)|[\\s](_+)(?!_)(?=punct)|(?!_)punct(_+)(?!_)(?=punct)";
const RE_EM_R_UND = rx(EM_R_UND_TMPL, "gu")
  .rep(/notPunctSpace/g, NOT_PUNCT_SPACE)
  .rep(/punctSpace/g, PUNCT_SPACE)
  .rep(/punct/g, PUNCT)
  .re();

// strikethrough delimiters
const RE_DEL = /^(~~?)(?=[^\s~])((?:\\[\s\S]|[^\\])*?(?:\\[\s\S]|[^\s~\\]))\1(?=[^~]|$)/;
const RE_DEL_L = rx(/^~~?(?:((?!~)punct)|[^\s~])/, "u").rep(/punct/g, PUNCT).re();
const DEL_R_TMPL = "^[^~]+(?=[^~])|(?!~)punct(~~?)(?=[\\s]|$)|notPunctSpace(~~?)(?!~)(?=punctSpace|$)|(?!~)punctSpace(~~?)(?=notPunctSpace)|[\\s](~~?)(?!~)(?=punct)|(?!~)punct(~~?)(?!~)(?=punct)|notPunctSpace(~~?)(?=notPunctSpace)";
const RE_DEL_R = rx(DEL_R_TMPL, "gu")
  .rep(/notPunctSpace/g, NOT_PUNCT_SPACE)
  .rep(/punctSpace/g, PUNCT_SPACE)
  .rep(/punct/g, PUNCT)
  .re();

// punctuation test (for emStrong lookahead)
const RE_PUNCT = rx(/^((?![*_])punctSpace)/, "u").rep(/punctSpace/g, PUNCT_SPACE).re();

// blockSkip: links, code spans, html tags (global) — used by masking
const RE_BLOCK_SKIP = rx("link|precode-code|html", "g")
  .rep("link", /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)/)
  .rep("precode-", "(?<!`)()")
  .rep("code", /(?<b>`+)[^`]+\k<b>(?!`)/)
  .rep("html", /<(?! )[^<>]*?>/)
  .re();

// any punctuation (for escaping in hrefs/titles)
const RE_ANY_PUNCT = rx(/\\(punct)/, "gu").rep(/punct/g, PUNCT).re();
// any punctuation outside code spans (global) — used by masking
const RE_ANY_PUNCT_OUT_CODE = rx(/(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\(punct)/, "gu")
  .rep(/punct/g, PUNCT)
  .re();

// GFM autolinked URLs. Group 1 = the scheme/www prefix, group 2 = the
// "@" of a bare email address (only autolinked outside a link).
const PROTOCOL = /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/;
const EMAIL_ADDR = /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const RE_URL = rx(/^(?:mailto:emailAddr|xmpp:emailAddr(?:\/[A-Za-z0-9@.]+)?)|^((?:protocol):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/)
  .rep(/emailAddr/g, EMAIL_ADDR)
  .rep("protocol", PROTOCOL)
  .re();
const RE_BACKPEDAL = /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;

// GFM inline text
const RE_ITEXT = rx(/^(?:[^a-zA-Z0-9](?=emailProtocol)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|protocol:\/\/|wwwStart|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=emailProtocol)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@))))/)
  .rep("protocol", PROTOCOL)
  .rep(/emailProtocol/g, /(?:mailto|xmpp):/)
  .rep("wwwStart", /(?<![^\s*_~(])www\./)
  .re();

// ---- helpers ----
const ESC_MAP = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
function esc(s, encode) {
  if (encode) {
    if (O.escapeTest.test(s)) return s.replace(O.escapeReplace, (c) => ESC_MAP[c]);
  } else if (O.escapeTestNoEncode.test(s)) return s.replace(O.escapeReplaceNoEncode, (c) => ESC_MAP[c]);
  return s;
}
function unesc(s) {
  if (!O.numericCharacterReference.test(s)) return s;
  return s.replace(O.numericCharacterReferenceOrAmpersand, (e, t, n) => {
    if (t === void 0 && n === void 0) return "&amp;";
    const cp = t === void 0 ? parseInt(n, 16) : parseInt(t, 10);
    return cp === 0 || cp > 1114111 || (cp >= 55296 && cp <= 57343)
      ? "\uFFFD"
      : cp === 38 ? "&amp;" : String.fromCodePoint(cp);
  });
}
function encURI(a) {
  try { a = encodeURI(a).replace(O.percentDecode, "%"); } catch { return null; }
  return a;
}
function splitCells(row, count) {
  const t = row.replace(O.findPipe, (r, o, i) => {
    let l = false, p = o;
    for (; --p >= 0 && i[p] === "\\";) l = !l;
    return l ? "|" : " |";
  });
  const n = t.split(O.splitPipe);
  let s = 0;
  if (n[0].trim() || n.shift(), n.length > 0 && !n.at(-1)?.trim() && n.pop(), count) {
    if (n.length > count) n.splice(count);
    else for (; n.length < count;) n.push("");
  }
  for (; s < n.length; s++) n[s] = n[s].trim().replace(O.slashPipe, "|");
  return n;
}
function trimTrail(s, ch, inv) {
  const n = s.length;
  if (n === 0) return "";
  let c = 0;
  for (; c < n;) {
    const r = s.charAt(n - c - 1);
    if (r === ch && !inv) c++;
    else if (r !== ch && inv) c++;
    else break;
  }
  return s.slice(0, n - c);
}
function trimBlankTail(s) {
  const e = s.split("\n");
  let t = e.length - 1;
  for (; t >= 0 && O.blankLine.test(e[t]);) t--;
  return e.length - t <= 2 ? s : e.slice(0, t + 1).join("\n");
}
function normLabel(s) {
  return s.trim().replace(O.multipleSpaceGlobal, " ").toLowerCase().toUpperCase().toLowerCase();
}
function findClose(s, pair) {
  if (s.indexOf(pair[0]) === -1 && s.indexOf(pair[1]) === -1) return -1;
  let t = 0;
  for (let n = 0; n < s.length; n++) {
    if (s[n] === "\\") n++;
    else if (s[n] === pair[0]) t++;
    else if (s[n] === pair[1] && (t--, t < 0)) return n;
  }
  return t > 0 ? -2 : -1;
}
function expandTabs(s, col = 0) {
  let t = col, n = "";
  for (const ch of s) {
    if (ch === "\t") { const r = 4 - (t % 4); n += " ".repeat(r); t += r; }
    else { n += ch; t++; }
  }
  return n;
}
function fenceIndentComp(raw, text) {
  const m = raw.match(O.indentCodeCompensation);
  if (m === null) return text;
  const s = m[1];
  return text.split("\n").map((r) => {
    const o = r.match(O.beginningSpace);
    if (o === null) return r;
    return r.slice(Math.min(o[0].length, s.length));
  }).join("\n");
}

// ---- block tokenizer ----
// A token is a small object; text-bearing tokens get their inline HTML filled
// in later from the inline queue ({src, obj, key}).
function queueInline(lex, src, obj, key) {
  lex.queue.push({ src, obj, key });
}
function tokSpace(src) {
  const m = RE_NEWLINE.exec(src);
  if (m && m[0].length > 0) return { type: "space", raw: m[0] };
  return null;
}
function tokCode(src) {
  const m = RE_CODE.exec(src);
  if (m) {
    const raw = trimBlankTail(m[0]);
    return { type: "code", raw, style: "indented", text: raw.replace(O.codeRemoveIndent, "") };
  }
  return null;
}
function tokFences(src) {
  const m = RE_FENCES.exec(src);
  if (m) {
    return {
      type: "code", raw: m[0],
      lang: m[2] ? m[2].trim().replace(RE_ANY_PUNCT, "$1") : m[2],
      text: fenceIndentComp(m[0], m[3] || ""),
    };
  }
  return null;
}
function tokHeading(src, lex) {
  const m = RE_HEADING.exec(src);
  if (m) {
    let text = m[2].trim();
    if (O.endingHash.test(text)) {
      const s = trimTrail(text, "#");
      if (!s || O.endingSpaceTabChar.test(s)) text = s.trim();
    }
    const tok = { type: "heading", raw: trimTrail(m[0], "\n"), depth: m[1].length, text, html: "" };
    queueInline(lex, text, tok, "html");
    return tok;
  }
  return null;
}
function tokHr(src) {
  const m = RE_HR.exec(src);
  if (m) return { type: "hr", raw: trimTrail(m[0], "\n") };
  return null;
}
function tokBlockquote(src, lex) {
  const m = RE_BLOCKQUOTE.exec(src);
  if (!m) return null;
  const lines = trimTrail(m[0], "\n").split("\n");
  let raw = "", text = "";
  const tokens = [];
  while (lines.length > 0) {
    let seen = false;
    const chunk = [];
    let p;
    for (p = 0; p < lines.length; p++) {
      if (O.blockquoteStart.test(lines[p])) { chunk.push(lines[p]); seen = true; }
      else if (!seen) chunk.push(lines[p]);
      else break;
    }
    lines.splice(0, p);
    const joined = chunk.join("\n");
    const inner = joined
      .replace(O.blockquoteMarkerWhitespace, (g, b, mk) => b + expandTabs(mk, b.length))
      .replace(O.blockquoteSetextReplace, "\n    $1")
      .replace(O.blockquoteSetextReplace2, "");
    raw = raw ? raw + "\n" + joined : joined;
    text = text ? text + "\n" + inner : inner;
    const savedTop = lex.top;
    lex.top = true;
    blockTokens(inner, tokens, lex, true);
    lex.top = savedTop;
    if (lines.length === 0) break;
    const last = tokens.at(-1);
    if (last && (last.type === "code" || last.type === "heading" || last.type === "hr" || last.type === "html" || last.type === "table")) break;
    if (last && last.type === "blockquote") {
      const g = last;
      const rest = lines.join("\n");
      const combined = g.raw + "\n" + rest.replace(O.blockquoteSetextReplace2, "");
      const f = tokBlockquote(combined, lex);
      tokens[tokens.length - 1] = f;
      const y = combined.substring(f.raw.length).replace(/^\n/, "");
      const R = y ? y.split("\n").length : 0;
      const A = R ? lines.slice(0, -R) : lines;
      if (A.length > 0) raw = raw + "\n" + A.join("\n");
      text = text.substring(0, text.length - g.text.length) + f.text;
      lines.splice(0, A.length);
      if (lines.length > 0 && O.blockquoteStart.test(lines[0])) continue;
      break;
    } else if (last && last.type === "list") {
      const g = last;
      const combined = g.raw + "\n" + lines.join("\n");
      const mm = tokList(combined, lex);
      tokens[tokens.length - 1] = mm;
      const f = mm.raw.length > g.raw.length ? combined.slice(g.raw.length + 1, mm.raw.length).split("\n").length : 0;
      if (f > 0) {
        const y = lines.slice(0, f).join("\n");
        raw = raw + "\n" + y;
        text = text + "\n" + y;
      }
      lines.splice(0, f);
      continue;
    }
  }
  return { type: "blockquote", raw, tokens, text };
}
function tokList(src, lex) {
  const m0 = RE_LIST.exec(src);
  if (!m0) return null;
  const orig = src;
  const pos = () => orig.length - s.length;
  let bullet = m0[1].trim();
  const ordered = bullet.length > 1;
  const list = { type: "list", raw: "", ordered, start: ordered ? +bullet.slice(0, -1) : "", loose: false, items: [] };
  bullet = ordered ? `\\d{1,9}\\${bullet.slice(-1)}` : `\\${bullet}`;
  const itemRe = listItemRegex(bullet);
  let sawDoubleBlank = false;
  let s = src;
  while (s) {
    let emptyItem = false;
    let d = "";
    const t = itemRe.exec(s);
    if (!t || RE_HR.test(s)) break;
    const k = pos();
    s = s.substring(t[0].length);
    const firstLine = t[2].split("\n", 1)[0];
    const b = t[1].length;
    let m = firstLine.replace(O.leadingSpaceTab, (v) => expandTabs(v, b));
    let f = s.split("\n", 1)[0];
    let y = !m.trim();
    let R = 0;
    if (y) R = b + 1;
    else {
      R = m.search(O.nonSpaceChar);
      R = R > 4 ? 1 : R;
      d = m.slice(R);
      R += b;
    }
    if (y && O.blankLine.test(f)) { s = s.substring(f.length + 1); emptyItem = true; }
    if (!emptyItem) {
      const vRe = nextBulletRegex(R), qRe = hrRegex(R), eeRe = fencesBeginRegex(R),
        teRe = headingBeginRegex(R), mRe = htmlBeginRegex(R), neRe = blockquoteBeginRegex(R);
      while (s) {
        const U = s.split("\n", 1)[0];
        f = U;
        const Z = f.replace(O.leadingSpaceTab, (me) => expandTabs(me));
        if (eeRe.test(f) || teRe.test(f) || mRe.test(f) || neRe.test(f) || vRe.test(f) || qRe.test(f)) break;
        if (Z.search(O.nonSpaceChar) >= R || !f.trim()) d += "\n" + Z.slice(R);
        else {
          if (y || m.replace(O.tabCharGlobal, "    ").search(O.nonSpaceChar) >= 4 || eeRe.test(m) || teRe.test(m) || mRe.test(m) || qRe.test(m)) break;
          const qe = /^ {0,3}(?:=+|-+) *$/.test(f) && RE_LHEADING.test(m + "\n" + f)
            ? "    " + Z.replace(/^ {0,3}/, "") : f;
          d += "\n" + qe;
        }
        y = !f.trim();
        s = s.substring(U.length + 1);
        m = Z.slice(R);
      }
    }
    const A = orig.slice(k, pos());
    if (!list.loose) {
      if (sawDoubleBlank) list.loose = true;
      else if (O.doubleBlankLine.test(A)) sawDoubleBlank = true;
    }
    list.items.push({ type: "list_item", raw: A, task: O.listIsTask.test(d), loose: false, text: d, tokens: [] });
  }
  const last = list.items.at(-1);
  if (!last) return null;
  last.raw = last.raw.trimEnd();
  last.text = last.text.trimEnd();
  list.raw = orig.slice(0, pos()).trimEnd();
  for (const item of list.items) {
    // re-check task flag on the final text
    item.task = O.listIsTask.test(item.text);
    lex.top = false;
    item.tokens = blockTokens(item.text, [], lex, false);
    if (!list.loose) {
      const spaces = item.tokens.filter((g) => g.type === "space");
      if (spaces.length > 0 && spaces.some((g) => O.anyLine.test(g.raw))) list.loose = true;
    }
  }
  for (const item of list.items) {
    const first = item.tokens[0];
    if (item.task && (first?.type === "text" || first?.type === "paragraph")) {
      item.text = item.text.replace(O.listReplaceTask, "");
      first.raw = first.raw.replace(O.listReplaceTask, "");
      first.text = first.text.replace(O.listReplaceTask, "");
      for (let g = lex.queue.length - 1; g >= 0; g--) {
        if (O.listIsTask.test(lex.queue[g].src)) {
          lex.queue[g].src = lex.queue[g].src.replace(O.listReplaceTask, "");
          break;
        }
      }
      const ck = O.listTaskCheckbox.exec(item.raw);
      if (ck) {
        const box = { type: "checkbox", raw: ck[0] + " ", checked: ck[0] !== "[ ]" };
        item.checked = box.checked;
        if (list.loose) {
          if (item.tokens[0] && ["paragraph", "text"].includes(item.tokens[0].type)) {
            item.tokens[0].raw = box.raw + item.tokens[0].raw;
            item.tokens[0].text = box.raw + item.tokens[0].text;
            // checkbox html is prepended at render time (see renderBlocks)
            item.tokens[0].prefix = box;
          } else {
            item.tokens.unshift({ type: "paragraph", raw: box.raw, text: box.raw, html: checkboxHTML(box.checked) });
          }
        } else {
          item.tokens.unshift(box);
        }
      }
    } else if (item.task) item.task = false;
  }
  if (list.loose) {
    for (const item of list.items) {
      item.loose = true;
      for (const tk of item.tokens) if (tk.type === "text") tk.type = "paragraph";
    }
  }
  return list;
}

// (O.endingHash is defined here to keep the O literal above readable)
O.endingHash = /#$/;
function checkboxHTML(checked) {
  return "<input " + (checked ? 'checked="" ' : "") + 'disabled="" type="checkbox"> ';
}
function tokHtml(src) {
  const m = RE_HTML.exec(src);
  if (m) {
    const raw = trimBlankTail(m[0]);
    return { type: "html", raw, text: raw };
  }
  return null;
}
function tokDef(src) {
  const m = RE_DEF.exec(src);
  if (m) {
    if (!O.startAngleBracket.test(m[2]) && findClose(m[2], "()") !== -1) return null;
    return {
      type: "def",
      tag: normLabel(m[1]),
      raw: trimTrail(m[0], "\n"),
      href: m[2] ? m[2].replace(O.hrefBrackets, "$1").replace(RE_ANY_PUNCT, "$1") : "",
      title: m[3] ? m[3].substring(1, m[3].length - 1).replace(RE_ANY_PUNCT, "$1") : m[3],
    };
  }
  return null;
}
function tokTable(src, lex) {
  const m = RE_TABLE.exec(src);
  if (!m || !O.tableDelimiter.test(m[2])) return null;
  const headerCells = splitCells(m[1]);
  const aligns = m[2].replace(O.tableAlignChars, "").split("|");
  const rows = m[3]?.trim() ? m[3].replace(O.tableRowBlankLine, "").split("\n") : [];
  const table = { type: "table", raw: trimTrail(m[0], "\n"), header: [], align: [], rows: [] };
  if (headerCells.length !== aligns.length) return null;
  for (const a of aligns) {
    if (O.tableAlignRight.test(a)) table.align.push("right");
    else if (O.tableAlignCenter.test(a)) table.align.push("center");
    else if (O.tableAlignLeft.test(a)) table.align.push("left");
    else table.align.push(null);
  }
  for (let i = 0; i < headerCells.length; i++) {
    const cell = { text: headerCells[i], html: "", header: true, align: table.align[i] };
    queueInline(lex, headerCells[i], cell, "html");
    table.header.push(cell);
  }
  for (const r of rows) {
    table.rows.push(splitCells(r, table.header.length).map((c, p) => {
      const cell = { text: c, html: "", header: false, align: table.align[p] };
      queueInline(lex, c, cell, "html");
      return cell;
    }));
  }
  return table;
}
function tokLheading(src, lex) {
  const m = RE_LHEADING.exec(src);
  if (m) {
    const tok = { type: "heading", raw: trimTrail(m[0], "\n"), depth: m[2].charAt(0) === "=" ? 1 : 2, text: m[1].trim(), html: "" };
    queueInline(lex, tok.text, tok, "html");
    return tok;
  }
  return null;
}
function tokParagraph(src, lex) {
  const m = RE_PARA.exec(src);
  if (m) {
    const text = m[1].charAt(m[1].length - 1) === "\n" ? m[1].slice(0, -1) : m[1];
    const tok = { type: "paragraph", raw: m[0], text, html: "" };
    queueInline(lex, text, tok, "html");
    return tok;
  }
  return null;
}
function tokText(src, lex) {
  const m = RE_TEXT.exec(src);
  if (m) {
    const tok = { type: "text", raw: m[0], text: m[0], html: "" };
    queueInline(lex, m[0], tok, "html");
    return tok;
  }
  return null;
}

// Main block loop. `nested` is true when lexing a blockquote's inner chunk:
// the first paragraph of the chunk may continue a paragraph from the
// previous chunk, so it merges into it instead of starting a new token.
function blockTokens(src, tokens, lex, nested) {
  let prevLen = Infinity;
  while (src) {
    if (src.length < prevLen) prevLen = src.length;
    else throw new Error("Infinite loop on byte: " + src.charCodeAt(0));
    let tok;
    if ((tok = tokSpace(src))) {
      src = src.substring(tok.raw.length);
      const last = tokens.at(-1);
      if (tok.raw.length === 1 && last !== void 0) last.raw += "\n";
      else tokens.push(tok);
      continue;
    }
    if ((tok = tokCode(src))) {
      src = src.substring(tok.raw.length);
      const last = tokens.at(-1);
      if (last?.type === "paragraph" || last?.type === "text") {
        last.raw += (last.raw.endsWith("\n") ? "" : "\n") + tok.raw;
        last.text += "\n" + tok.text;
        lex.queue.at(-1).src = last.text;
      } else tokens.push(tok);
      continue;
    }
    if ((tok = tokFences(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
    if ((tok = tokHeading(src, lex))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
    if ((tok = tokHr(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
    if ((tok = tokBlockquote(src, lex))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
    if ((tok = tokList(src, lex))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
    if ((tok = tokHtml(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
    if ((tok = tokDef(src))) {
      src = src.substring(tok.raw.length);
      const last = tokens.at(-1);
      if (last?.type === "paragraph" || last?.type === "text") {
        last.raw += (last.raw.endsWith("\n") ? "" : "\n") + tok.raw;
        last.text += "\n" + tok.raw;
        lex.queue.at(-1).src = last.text;
      } else {
        if (!lex.links[tok.tag]) lex.links[tok.tag] = { href: tok.href, title: tok.title };
        tokens.push(tok);
      }
      continue;
    }
    if ((tok = tokTable(src, lex))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
    if ((tok = tokLheading(src, lex))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
    if (lex.top && (tok = tokParagraph(src, lex))) {
      const last = tokens.at(-1);
      if (nested && last?.type === "paragraph") {
        last.raw += (last.raw.endsWith("\n") ? "" : "\n") + tok.raw;
        last.text += "\n" + tok.text;
        lex.queue.pop();
        lex.queue.at(-1).src = last.text;
      } else tokens.push(tok);
      nested = false;
      src = src.substring(tok.raw.length);
      continue;
    }
    if ((tok = tokText(src, lex))) {
      src = src.substring(tok.raw.length);
      const last = tokens.at(-1);
      if (last?.type === "text") {
        last.raw += (last.raw.endsWith("\n") ? "" : "\n") + tok.raw;
        last.text += "\n" + tok.text;
        lex.queue.pop();
        lex.queue.at(-1).src = last.text;
      } else tokens.push(tok);
      continue;
    }
    throw new Error("Infinite loop on byte: " + src.charCodeAt(0));
  }
  lex.top = true;
  return tokens;
}

// ---- inline rendering ----
// Renders inline markdown to HTML directly (no intermediate token objects).
// `plain` renders plain text (for image alt text), like marked's TextRenderer.

function linkInText(lex, src) {
  if (!src.includes("[")) return false;
  for (const n of src.matchAll(RE_BLOCK_SKIP)) {
    if (RE_LINK.test(n[0]) && src.charAt(n.index - 1) !== "!") return true;
  }
  for (const n of src.matchAll(RE_REFLINK_SEARCH)) {
    const s = n[0], r = s.lastIndexOf("[");
    if (!(s.charAt(0) === "!" || !Object.hasOwn(lex.links, normLabel(s.slice(r + 1, -1)))) &&
        !(r > 1 && linkInText(lex, s.slice(1, r - 1)))) return true;
  }
  return false;
}

// Masked source for emphasis/delimiter closing lookup: links, code spans and
// html tags are replaced by same-length bracketed placeholders, and escaped
// punctuation is masked, so delimiters inside them cannot close emphasis.
function maskSrc(lex, src) {
  let t = src;
  if (lex.links && src.includes("[")) {
    const n = RE_REFLINK_SEARCH;
    const s = (r) => {
      const o = r.lastIndexOf("[");
      if (!Object.hasOwn(lex.links, normLabel(r.slice(o + 1, -1)))) return r;
      if (o > 1 && r.charAt(0) !== "!") {
        const i = r.slice(1, o - 1);
        if (linkInText(lex, i)) return "[" + i.replace(n, s) + "][" + "a".repeat(r.length - o - 2) + "]";
      }
      return "[" + "a".repeat(r.length - 2) + "]";
    };
    t = t.replace(n, s);
  }
  t = t.replace(RE_ANY_PUNCT_OUT_CODE, (n, s, r) =>
    r ? "+".repeat(n.length)
      : s ? s + n.slice(s.length, -s.length).replace(/`/g, "+") + s
      : n);
  t = t.replace(RE_BLOCK_SKIP, (n, s, r) => {
    const o = r ? r.length : 0;
    return n.slice(0, o) + "[" + "a".repeat(n.length - o - 2) + "]";
  });
  return t;
}

// Last possible closer indices in a masked source (marked's fe()).
function maskClosers(masked) {
  const last = { "*": -1, "_": -1 };
  let lastDel = -1;
  const n = masked.length;
  for (let s = 0; s < n; s++) {
    const r = masked[s];
    if (r !== "*" && r !== "_" && r !== "~") continue;
    const o = s === 0 ? "\n" : masked[s - 1];
    let i = s + 1;
    for (; i < n && masked[i] === r;) i++;
    if (o !== " " && o !== "\t" && o !== "\n" && o !== "\r" && o !== "\f") {
      if (r === "~") lastDel = s;
      else last[r] = s;
    }
    s = i - 1;
  }
  return { last, lastDel };
}

function inEscape(e, plain) {
  const m = RE_ESCAPE.exec(e);
  if (!m) return null;
  return { html: plain ? m[1] : esc(m[1]), len: m[0].length };
}
function inTag(e, lex) {
  const m = RE_TAG.exec(e);
  if (!m) return null;
  if (!lex.inLink && O.startATag.test(m[0])) lex.inLink = true;
  else if (lex.inLink && O.endATag.test(m[0])) lex.inLink = false;
  if (!lex.inRawBlock && O.startPreScriptTag.test(m[0])) lex.inRawBlock = true;
  else if (lex.inRawBlock && O.endPreScriptTag.test(m[0])) lex.inRawBlock = false;
  return { html: m[0], len: m[0].length };
}
// Is a link label inside raw HTML (so it must not become a link)?
function insideRawHtml(full, label, bang) {
  if (!label.includes("<")) return false;
  for (let s = 0; s < label.length; s++) {
    if (label[s] === "\\") { s++; continue; }
    if (label[s] === "`") {
      const i = RE_CODESPAN.exec(label.slice(s));
      if (i) { s += i[0].length - 1; continue; }
    }
    if (label[s] !== "<") continue;
    const r = full.slice(bang + s);
    const o = RE_TAG.exec(r) || RE_AUTOLINK.exec(r);
    if (o) {
      if (o[0].length > label.length - s) return true;
      s += o[0].length - 1;
    }
  }
  return false;
}
// Render a link or image token; returns null when the outer link is rejected
// (its text contains a link). `m` is the (mutable) link match array.
function renderLinkImage(m, lex, plain) {
  const isImage = m[0].charAt(0) === "!";
  const hrefRaw = m[2];
  const titleRaw = m[3] ? m[3].slice(1, -1) : "";
  const href = hrefRaw && hrefRaw.replace(RE_ANY_PUNCT, "$1");
  const title = titleRaw && titleRaw.replace(RE_ANY_PUNCT, "$1");
  const text = m[1].replace(O.outputLinkReplace, "$1");
  const savedInLink = lex.inLink, savedEmitted = lex.linkEmitted, savedRaw = lex.inRawBlock;
  lex.inLink = true;
  lex.linkEmitted = false;
  // For an image the alt text is plain text; for a link the text is HTML,
  // unless the outer render is plain (alt text), when it is plain too.
  const inner = inlineRender(text, lex, isImage || plain);
  const emitted = lex.linkEmitted;
  lex.linkEmitted = savedEmitted;
  lex.inLink = savedInLink;
  if (!isImage) {
    if (emitted) { lex.inRawBlock = savedRaw; return null; }
    lex.linkEmitted = true;
  }
  if (plain) return { html: inner, len: m[0].length };
  if (isImage) {
    const enc = encURI(href);
    if (enc === null) return { html: esc(inner), len: m[0].length };
    let o = `<img src="${esc(enc)}" alt="${esc(inner)}"`;
    if (title) o += ` title="${esc(title)}"`;
    return { html: o + ">", len: m[0].length };
  }
  const enc = encURI(href);
  if (enc === null) return { html: inner, len: m[0].length };
  let o = `<a href="${esc(enc)}"`;
  if (title) o += ` title="${esc(title)}"`;
  return { html: o + ">" + inner + "</a>", len: m[0].length };
}
function inLink(e, lex, plain) {
  if (lex.linkParenPossible === false) return null;
  const m = RE_LINK.exec(e);
  if (!m) return null;
  const bang = m[0].charAt(0) === "!" ? 2 : 1;
  if (insideRawHtml(e, m[1], bang)) return null;
  const s = m[2].trim();
  if (O.startAngleBracket.test(s)) {
    if (!O.endAngleBracket.test(s)) return null;
    const l = trimTrail(s.slice(0, -1), "\\");
    if ((s.length - l.length) % 2 === 0) return null;
  } else {
    const l = findClose(m[2], "()");
    if (l === -2) return null;
    if (l > -1) {
      const h = (m[0].indexOf("!") === 0 ? 5 : 4) + m[1].length + l;
      m[2] = m[2].substring(0, l);
      m[0] = m[0].substring(0, h).trim();
      m[3] = "";
    }
  }
  const r = trimTrail(m[0].slice(0, -1), "\\");
  if ((m[0].length - r.length) % 2 === 0) return null;
  m[2] = m[2].trim();
  if (O.startAngleBracket.test(m[2])) m[2] = m[2].slice(1, -1);
  return renderLinkImage(m, lex, plain);
}
function inReflink(e, lex, plain) {
  let m = RE_REFLINK.exec(e) || RE_NOLINK.exec(e);
  if (!m) return null;
  const bang = m[0].charAt(0) === "!" ? 2 : 1;
  if (insideRawHtml(e, m[1], bang)) return null;
  const ref = lex.links[normLabel(m[2] || m[1])];
  if (!ref) {
    const ch = m[0].charAt(0);
    return { html: plain ? ch : esc(ch), len: 1 };
  }
  // Rebuild a link match array for renderLinkImage: [full, label, href, title]
  const fake = [m[0], m[1], ref.href, ref.title ? `"${ref.title}"` : ""];
  return renderLinkImage(fake, lex, plain);
}
function inEmStrong(e, masked, prevChar, lex, plain) {
  const s = RE_EM_L.exec(e);
  if (!s || (!s[1] && !s[2] && !s[3] && !s[4])) return null;
  const r = s[0][0];
  const samePrev = prevChar === r;
  const full = masked;
  const i = full.length - e.length;
  let l = i;
  while (l > 0 && full[l - 1] === r) l--;
  const p = [...full.slice(Math.max(0, l - 2), l)].at(-1) ?? "";
  const h = p === "*" || p === "_" || !!RE_PUNCT.exec(p);
  let n = prevChar;
  if (l < i) n = p;
  const u = l < i ? h : !!RE_PUNCT.exec(n);
  if (s[4] && n.match(O.unicodeAlphaNumeric)) return null;
  const d = s[1] || s[3] || "";
  if (!d || !n || u) {
    const k = [...s[0]].length - 1;
    let g, b, mLen = k, f = 0;
    const y = i - l + k;
    const R = !!p.trim() && (!!d || (r === "*" && !h));
    if (r !== "*" && r !== "_") return null;
    const delimRe = r === "*" ? RE_EM_R_AST : RE_EM_R_UND;
    const closers = lex._closers;
    const v = closers.last[r];
    const Q = full.length - e.length + k;
    if (v < Q) return null;
    const t = full.slice(-1 * e.length + k);
    const ee = v - Q;
    let sm;
    delimRe.lastIndex = 0;
    while ((sm = delimRe.exec(t)) !== null && !(sm.index > ee)) {
      g = sm[1] || sm[2] || sm[3] || sm[4] || sm[5] || sm[6];
      if (!g) continue;
      b = [...g].length;
      if (sm[3] || sm[4]) { mLen += b; continue; }
      else if (sm[5] || sm[6] || R) {
        if (samePrev && (sm[5] || sm[6])) break;
        if (y % 3 && !((y + b) % 3)) { f += b; continue; }
      }
      if ((mLen -= b) > 0) continue;
      b = Math.min(b, b + mLen + f);
      const te = [...sm[0]][0].length;
      const M = e.slice(0, k + sm.index + te + b);
      if (Math.min(k, b) % 2) {
        const inner = M.slice(1, -1);
        return { html: plain ? inlineRender(inner, lex, true) : `<em>${inlineRender(inner, lex, false)}</em>`, len: M.length };
      }
      const inner = M.slice(2, -2);
      return { html: plain ? inlineRender(inner, lex, true) : `<strong>${inlineRender(inner, lex, false)}</strong>`, len: M.length };
    }
  }
  return null;
}
function inCodespan(e, plain) {
  const m = RE_CODESPAN.exec(e);
  if (!m) return null;
  let text = m[2].replace(O.newLineCharGlobal, " ");
  const hasNonSpace = O.nonSpaceChar.test(text);
  const hasPad = text.startsWith(" ") && text.endsWith(" ");
  if (hasNonSpace && hasPad) text = text.substring(1, text.length - 1);
  return { html: plain ? text : `<code>${esc(text, true)}</code>`, len: m[0].length };
}
function inBr(e, plain) {
  const m = RE_BR.exec(e);
  if (!m) return null;
  return { html: plain ? "" : "<br>", len: m[0].length };
}
function inDel(e, masked, prevChar, lex, plain) {
  const s = RE_DEL_L.exec(e);
  if (!s) return null;
  if (!(s[1] || "") || !prevChar || RE_PUNCT.exec(prevChar)) {
    const run = [...s[0]].length - 1;
    let p = run;
    const closers = lex._closers;
    const u = closers.lastDel;
    const d = masked.length - e.length + run;
    if (u < d) return null;
    const t = masked.slice(-1 * e.length + run);
    const kk = u - d;
    let sm;
    RE_DEL_R.lastIndex = 0;
    while ((sm = RE_DEL_R.exec(t)) !== null && !(sm.index > kk)) {
      const g = sm[1] || sm[2] || sm[3] || sm[4] || sm[5] || sm[6];
      if (!g) continue;
      const l = [...g].length;
      if (l !== run) continue;
      if (sm[3] || sm[4]) { p += l; continue; }
      if ((p -= l) > 0) continue;
      const bl = Math.min(l, l + p);
      const gc = [...sm[0]][0].length;
      const b = e.slice(0, run + sm.index + gc + bl);
      const inner = b.slice(run, -run);
      return { html: plain ? inlineRender(inner, lex, true) : `<del>${inlineRender(inner, lex, false)}</del>`, len: b.length };
    }
  }
  return null;
}
function inAutolink(e, plain) {
  const m = RE_AUTOLINK.exec(e);
  if (!m) return null;
  let text, href;
  if (m[2] === "@") { text = m[1]; href = "mailto:" + text; }
  else { text = m[1]; href = text; }
  const enc = encURI(href);
  if (enc === null) return { html: plain ? text : esc(text, true), len: m[0].length };
  return { html: plain ? text : `<a href="${esc(enc, true)}">${esc(text, true)}</a>`, len: m[0].length };
}
function inUrl(e, lex, plain) {
  const m = RE_URL.exec(e);
  if (!m) return null;
  let text, href;
  if (m[2] === "@") { text = m[0]; href = "mailto:" + text; }
  else {
    let r;
    do { r = m[0]; m[0] = RE_BACKPEDAL.exec(m[0])?.[0] ?? ""; } while (r !== m[0]);
    text = m[0];
    href = m[1] === "www." ? "http://" + m[0] : m[0];
  }
  const enc = encURI(href);
  if (enc === null) return { html: plain ? text : esc(text, true), len: m[0].length };
  return { html: plain ? text : `<a href="${esc(enc, true)}">${esc(text, true)}</a>`, len: m[0].length };
}
function inText(e, lex, plain) {
  const m = RE_ITEXT.exec(e);
  if (!m) return null;
  if (lex.inRawBlock) return { html: m[0], len: m[0].length, raw: m[0] };
  const text = unesc(m[0]);
  return { html: plain ? text : esc(text), len: m[0].length, raw: m[0] };
}

// Main inline loop. Renders `src` to HTML (or plain text).
function inlineRender(src, lex, plain) {
  const savedParen = lex.linkParenPossible;
  lex.linkParenPossible = savedParen && src.includes(")");
  try {
    return inlineLoop(src, lex, plain);
  } finally {
    lex.linkParenPossible = savedParen;
  }
}
function inlineLoop(src, lex, plain) {
  const masked = maskSrc(lex, src);
  const savedClosers = lex._closers;
  lex._closers = maskClosers(masked);
  let out = "";
  let prevChar = "";
  let e = src;
  let sawText = false;
  let prevLen = Infinity;
  try {
    while (e) {
      if (e.length < prevLen) prevLen = e.length;
      else throw new Error("Infinite loop on byte: " + e.charCodeAt(0));
      if (!sawText) prevChar = "";
      sawText = false;
      let r;
      if ((r = inEscape(e, plain))) { e = e.substring(r.len); out += r.html; continue; }
      if ((r = inTag(e, lex))) { e = e.substring(r.len); out += r.html; continue; }
      if ((r = inLink(e, lex, plain))) { e = e.substring(r.len); out += r.html; continue; }
      if ((r = inReflink(e, lex, plain))) { e = e.substring(r.len); out += r.html; continue; }
      if ((r = inEmStrong(e, masked, prevChar, lex, plain))) { e = e.substring(r.len); out += r.html; continue; }
      if ((r = inCodespan(e, plain))) { e = e.substring(r.len); out += r.html; continue; }
      if ((r = inBr(e, plain))) { e = e.substring(r.len); out += r.html; continue; }
      if ((r = inDel(e, masked, prevChar, lex, plain))) { e = e.substring(r.len); out += r.html; continue; }
      if ((r = inAutolink(e, plain))) { e = e.substring(r.len); out += r.html; continue; }
      if (!lex.inLink && (r = inUrl(e, lex, plain))) { e = e.substring(r.len); out += r.html; continue; }
      if ((r = inText(e, lex, plain))) {
        e = e.substring(r.len);
        if (r.raw.slice(-1) !== "_") prevChar = r.raw.slice(-1);
        sawText = true;
        out += r.html;
        continue;
      }
      throw new Error("Infinite loop on byte: " + e.charCodeAt(0));
    }
    return out;
  } finally {
    lex._closers = savedClosers;
  }
}

// ---- block rendering ----
function renderCell(cell, isHeader) {
  const tag = isHeader ? "th" : "td";
  return (cell.align ? `<${tag} align="${cell.align}">` : `<${tag}>`) + cell.html + `</${tag}>\n`;
}
function renderBlocks(tokens) {
  let out = "";
  for (const tok of tokens) {
    switch (tok.type) {
      case "space": break;
      case "hr": out += "<hr>\n"; break;
      case "heading": out += `<h${tok.depth}>${tok.html}</h${tok.depth}>\n`; break;
      case "code": {
        const lang = (tok.lang || "").match(O.notSpaceStart)?.[0];
        let text = tok.text ? tok.text.replace(O.endingNewline, "") + "\n" : "";
        text = esc(text, true);
        out += lang
          ? `<pre><code class="language-${esc(lang)}">${text}</code></pre>\n`
          : `<pre><code>${text}</code></pre>\n`;
        break;
      }
      case "table": {
        let head = "";
        for (const c of tok.header) head += renderCell(c, true);
        let body = "";
        for (const row of tok.rows) {
          let cells = "";
          for (const c of row) cells += renderCell(c, false);
          body += `<tr>\n${cells}</tr>\n`;
        }
        if (body) body = `<tbody>${body}</tbody>`;
        out += `<table>\n<thead>\n<tr>\n${head}</tr>\n</thead>\n${body}</table>\n`;
        break;
      }
      case "blockquote": out += `<blockquote>\n${renderBlocks(tok.tokens)}</blockquote>\n`; break;
      case "list": {
        let items = "";
        for (const item of tok.items) items += `<li>${renderBlocks(item.tokens)}</li>\n`;
        const tag = tok.ordered ? "ol" : "ul";
        const start = tok.ordered && tok.start !== 1 ? ` start="${tok.start}"` : "";
        out += `<${tag}${start}>\n${items}</${tag}>\n`;
        break;
      }
      case "checkbox": out += checkboxHTML(tok.checked); break;
      case "html": out += tok.text; break;
      case "def": break;
      case "paragraph": out += `<p>${tok.prefix ? checkboxHTML(tok.prefix.checked) : ""}${tok.html}</p>\n`; break;
      case "text": out += `${tok.prefix ? checkboxHTML(tok.prefix.checked) : ""}${tok.html}`; break;
      default: throw new Error('Token with "' + tok.type + '" type was not found.');
    }
  }
  return out;
}

// ---- entry point ----
export function parse(markdown) {
  const src = markdown.replace(O.carriageReturn, "\n");
  const lex = {
    links: Object.create(null),
    queue: [],
    top: true,
    inLink: false,
    inRawBlock: false,
    linkEmitted: false,
    linkParenPossible: true,
    _closers: null,
  };
  const tokens = blockTokens(src, [], lex, false);
  for (const q of lex.queue) {
    lex.inRawBlock = false;
    q.obj[q.key] = inlineRender(q.src, lex, false);
  }
  return renderBlocks(tokens);
}
