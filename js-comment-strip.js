// Strip comments from JavaScript source for SOURCE-GREP assertions (C6a).
//
// Several of this repo's guards assert "no file still contains X". Two ways those
// guards go wrong, both learned the hard way:
//
//   • FALSE POSITIVE — a file legitimately NAMES a retired symbol in a comment while
//     explaining what replaced it. C5b hit this; the fix is to grep stripped source.
//   • FALSE NEGATIVE — a naive "cut from the first //" stripper eats the rest of a
//     line when a `//` appears inside a STRING first. `fetch("http://x"); BAD(...)`
//     would have its real violation swallowed and the guard would pass. This repo is
//     full of `"https://..."` literals, so that is not hypothetical.
//
// So this is a small state machine that tracks string / template-literal / regex
// context rather than a regex over the raw text. Comments are replaced with a single
// space (not removed) so nothing on either side accidentally joins into a new token.
//
// Its own edge cases are pinned in render-surface-registry.test.js — a stripper
// nobody has watched mis-handle a URL is a guess.
function stripJsComments(src) {
  const s = String(src == null ? "" : src);
  let out = "";
  let i = 0;
  // Regex-literal detection needs to know whether a `/` starts a division or a
  // pattern. The answer is "whatever the last significant token was": after a value
  // (identifier, number, `)`, `]`, `}`) a slash divides; otherwise it opens a regex.
  let prevSignificant = "";
  while (i < s.length) {
    const c = s[i];
    const next = s[i + 1];
    if (c === "/" && next === "/") {
      while (i < s.length && s[i] !== "\n") i++;
      out += " ";
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (i < s.length && !(s[i] === "*" && s[i + 1] === "/")) i++;
      i += 2;
      out += " ";
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      out += c; i++;
      while (i < s.length) {
        if (s[i] === "\\") { out += s[i] + (s[i + 1] || ""); i += 2; continue; }
        out += s[i];
        if (s[i] === quote) { i++; break; }
        i++;
      }
      prevSignificant = quote;
      continue;
    }
    if (c === "/" && !/[A-Za-z0-9_$)\]}]/.test(prevSignificant)) {
      // Regex literal: consume to the unescaped closing slash, honouring [...] where
      // a `/` is an ordinary character.
      out += c; i++;
      let inClass = false;
      while (i < s.length) {
        if (s[i] === "\\") { out += s[i] + (s[i + 1] || ""); i += 2; continue; }
        if (s[i] === "[") inClass = true;
        else if (s[i] === "]") inClass = false;
        else if (s[i] === "/" && !inClass) { out += s[i]; i++; break; }
        else if (s[i] === "\n") break;      // unterminated: bail rather than eat the file
        out += s[i]; i++;
      }
      prevSignificant = "/";
      continue;
    }
    if (!/\s/.test(c)) prevSignificant = c;
    out += c; i++;
  }
  return out;
}

module.exports = { stripJsComments };
