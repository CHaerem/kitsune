// Whether a rule matches an address. A rule is text to find in the address, or
// /a regular expression/.
//
// The expression is not given to Firefox's engine, because that engine can take for
// ever: /(a+)+$/ on thirty a's took 17 seconds in a test Firefox, on forty it takes days.
// Rules are looked at on every top-level navigation while the request waits, in the
// process all extensions share, so one careless rule, or a long address made to hit one,
// would stop every page from loading, with no sign of why. And JavaScript has no way to
// stop a running expression. So it runs here, in time that grows with the address and
// never more: each place in the expression is visited at most once per character.
//
// That rules out what needs more than this: look-around and back-references, which a
// rule about an address hardly ever needs. Such a rule does nothing, and the settings
// page says so (ruleProblem). Firefox's own parser still reads each expression first, so
// what is valid stays exactly what you know from elsewhere.
const { ruleMatches, ruleProblem } = (() => {
  const LONGEST_ADDRESS = 4096; // a longer one is a search or a tracker's: what decides is at the start
  const BIGGEST_PROGRAM = 5000; // (a{1000}){1000} would otherwise fill the memory

  class Unusable extends Error {}
  const CHAR = 0, SPLIT = 1, JUMP = 2, START = 3, END = 4, WORD_EDGE = 5, NOT_WORD_EDGE = 6, MATCH = 7;

  const code = s => s.charCodeAt(0);
  const isDigit = c => c >= 48 && c <= 57;
  const isWordChar = c => isDigit(c) || (c >= 65 && c <= 90) || c === 95 || (c >= 97 && c <= 122);
  const isSpace = c => /\s/.test(String.fromCharCode(c));
  const isLineEnd = c => c === 10 || c === 13 || c === 0x2028 || c === 0x2029;
  const not = test => c => !test(c);

  // The expression as a tree: { char }, { all: [...] }, { any: [...] }, { repeat, min, max }, { at }.
  function parse(source) {
    let i = 0;
    const peek = () => source[i];

    function alternatives() {
      const any = [sequence()];
      while (peek() === "|") { i++; any.push(sequence()); }
      return any.length === 1 ? any[0] : { any };
    }
    function sequence() {
      const all = [];
      while (i < source.length && peek() !== "|" && peek() !== ")") all.push(quantified(atom()));
      return { all };
    }
    function quantified(node) {
      const c = peek();
      let min, max;
      if (c === "*") { min = 0; max = Infinity; i++; }
      else if (c === "+") { min = 1; max = Infinity; i++; }
      else if (c === "?") { min = 0; max = 1; i++; }
      else {
        // (Not one of these, { is an ordinary character.)
        const braces = c === "{" && /^\{(\d+)(,(\d*))?\}/.exec(source.slice(i));
        if (!braces) return node;
        min = Number(braces[1]);
        max = braces[2] === undefined ? min : braces[3] === "" ? Infinity : Number(braces[3]);
        i += braces[0].length;
      }
      if (peek() === "?") i++; // lazy or greedy says which match, not whether there is one
      return { repeat: node, min, max };
    }
    function atom() {
      const c = source[i++];
      if (c === "^") return { at: START };
      if (c === "$") return { at: END };
      if (c === ".") return { char: not(isLineEnd), dot: true };
      if (c === "[") return charClass();
      if (c === "(") return group();
      if (c === "\\") return escape(false);
      return literal(code(c));
    }
    function group() {
      if (peek() === "?") {
        if (source.startsWith("?:", i)) i += 2;
        else if (/^\?<[^=!]/.test(source.slice(i, i + 3))) i = source.indexOf(">", i) + 1;
        else throw new Unusable("look-around");
      }
      const inner = alternatives();
      i++; // ) : Firefox's parser has seen that it is there
      return inner;
    }
    function escape(inClass) {
      const c = source[i++];
      switch (c) {
        case "d": return { char: isDigit };
        case "D": return { char: not(isDigit) };
        case "w": return { char: isWordChar };
        case "W": return { char: not(isWordChar) };
        case "s": return { char: isSpace };
        case "S": return { char: not(isSpace) };
        case "t": return literal(9);
        case "n": return literal(10);
        case "v": return literal(11);
        case "f": return literal(12);
        case "r": return literal(13);
        case "b": if (inClass) return literal(8); return { at: WORD_EDGE };
        case "B": if (inClass) return literal(66); return { at: NOT_WORD_EDGE };
        case "x": case "u": {
          const hex = new RegExp(`^[0-9a-fA-F]{${c === "x" ? 2 : 4}}`).exec(source.slice(i));
          if (source[i] === "{") throw new Unusable("other");
          if (!hex) return literal(code(c));
          i += hex[0].length;
          return literal(parseInt(hex[0], 16));
        }
        case "0":
          if (isDigit(code(source[i] ?? "x"))) throw new Unusable("back-reference");
          return literal(0);
        case "c": case "p": case "P": throw new Unusable("other");
        case "k": throw new Unusable("back-reference");
        default:
          if (isDigit(code(c))) throw new Unusable("back-reference"); // or an old octal: who can tell
          return literal(code(c));
      }
    }
    function charClass() {
      const negated = peek() === "^";
      if (negated) i++;
      const tests = [];
      const one = () => {
        const c = source[i++];
        return c === "\\" ? escape(true) : literal(code(c));
      };
      while (peek() !== "]") {
        const from = one();
        // A range only between two single characters; otherwise the - is itself a character.
        if (peek() === "-" && source[i + 1] !== "]") {
          i++;
          const to = one();
          if (from.code !== undefined && to.code !== undefined) {
            tests.push(c => c >= from.code && c <= to.code);
            continue;
          }
          tests.push(from.char, literal(45).char, to.char);
          continue;
        }
        tests.push(from.char);
      }
      i++; // ]
      return { char: c => tests.some(test => test(c)), negated };
    }
    const tree = alternatives();
    return tree;
    function literal(c) { return { code: c, char: other => other === c }; }
  }

  // The tree as a small program: one instruction per place in the expression.
  function compile(tree, { ignoreCase, dotAll }) {
    const program = [];
    const add = op => {
      if (program.length >= BIGGEST_PROGRAM) throw new Unusable("too big");
      program.push(op);
      return program.length - 1;
    };
    const foldCase = test => c => {
      const s = String.fromCharCode(c);
      return test(c) || test(code(s.toLowerCase())) || test(code(s.toUpperCase()));
    };
    function emit(node) {
      if (node.char) {
        // With /i, what is inside a [^...] is folded first: [^a] does not match A.
        const test = node.dot && dotAll ? () => true : ignoreCase ? foldCase(node.char) : node.char;
        add({ op: CHAR, test: node.negated ? not(test) : test });
      } else if (node.all) {
        node.all.forEach(emit);
      } else if (node.any) {
        const jumps = [];
        node.any.forEach((branch, n) => {
          const last = n === node.any.length - 1;
          const split = last ? null : add({ op: SPLIT });
          if (split !== null) program[split].a = program.length;
          emit(branch);
          if (!last) { jumps.push(add({ op: JUMP })); program[split].b = program.length; }
        });
        for (const j of jumps) program[j].to = program.length;
      } else if (node.repeat) {
        for (let n = 0; n < node.min; n++) emit(node.repeat);
        if (node.max === Infinity) {
          const split = add({ op: SPLIT });
          program[split].a = program.length;
          emit(node.repeat);
          add({ op: JUMP, to: split });
          program[split].b = program.length;
        } else {
          const splits = [];
          for (let n = node.min; n < node.max; n++) {
            const split = add({ op: SPLIT });
            program[split].a = program.length;
            splits.push(split);
            emit(node.repeat);
          }
          for (const s of splits) program[s].b = program.length;
        }
      } else if (node.at !== undefined) {
        add({ op: node.at });
      }
    }
    emit(tree);
    add({ op: MATCH });
    return program;
  }

  // Every place the expression can be at once, moved along the address together, so that
  // no place is ever tried twice for one character. Nothing can blow up from here on.
  function matcher(program, { multiline, sticky }) {
    const seen = new Int32Array(program.length).fill(-1);
    const stack = [];
    const startsAnchored = !multiline && program[0].op === START;
    return (text, cut) => {
      seen.fill(-1);
      const edge = at => (at > 0 && isWordChar(text.charCodeAt(at - 1))) !== (at < text.length && isWordChar(text.charCodeAt(at)));
      let now = [], next = [];
      // Adds a place and all it leads to without reading a character. True: a match.
      const reach = (from, at, list) => {
        stack.push(from);
        while (stack.length) {
          const pc = stack.pop();
          if (seen[pc] === at) continue;
          seen[pc] = at;
          const step = program[pc];
          switch (step.op) {
            case CHAR: list.push(pc); break;
            case JUMP: stack.push(step.to); break;
            case SPLIT: stack.push(step.b, step.a); break;
            case START: if (at === 0 || (multiline && isLineEnd(text.charCodeAt(at - 1)))) stack.push(pc + 1); break;
            case END: if ((at === text.length && !cut) || (multiline && isLineEnd(text.charCodeAt(at)))) stack.push(pc + 1); break;
            case WORD_EDGE: if (edge(at)) stack.push(pc + 1); break;
            case NOT_WORD_EDGE: if (!edge(at)) stack.push(pc + 1); break;
            case MATCH: stack.length = 0; return true;
          }
        }
        return false;
      };
      for (let at = 0; ; at++) {
        // Anywhere in the address, unless the expression says otherwise.
        if ((at === 0 || !(sticky || startsAnchored)) && reach(0, at, now)) return true;
        if (at === text.length || !now.length && (sticky || startsAnchored)) return false;
        const c = text.charCodeAt(at);
        for (const pc of now) {
          if (program[pc].test(c) && reach(pc + 1, at + 1, next)) return true;
        }
        [now, next] = [next, now];
        next.length = 0;
      }
    };
  }

  // A rule's matcher, or why it has none. Kept, since every navigation asks.
  const known = new Map();
  function read(rule) {
    let found = known.get(rule);
    if (found) return found;
    const re = /^\/(.+)\/([a-z]*)$/.exec(rule);
    if (!re) found = { test: url => url.includes(rule) };
    else {
      try {
        new RegExp(re[1], re[2]); // what is valid is what Firefox says; building it runs nothing
        if (re[2].includes("v")) throw new Unusable("other");
        found = {
          test: (run => url => run(url.slice(0, LONGEST_ADDRESS), url.length > LONGEST_ADDRESS))(matcher(
            compile(parse(re[1]), { ignoreCase: re[2].includes("i"), dotAll: re[2].includes("s") }),
            { multiline: re[2].includes("m"), sticky: re[2].includes("y") },
          )),
        };
      } catch (err) {
        found = { problem: err instanceof Unusable ? err.message : "invalid" };
      }
    }
    if (known.size >= 500) known.clear(); // edited rules
    known.set(rule, found);
    return found;
  }

  return {
    ruleMatches(rule, url) {
      if (typeof rule !== "string" || !rule) return false;
      return read(rule).test?.(url) ?? false;
    },
    // In words for the settings page, or null when the rule can be used.
    ruleProblem(rule) {
      const problem = typeof rule === "string" && rule ? read(rule).problem : null;
      if (!problem) return null;
      return {
        invalid: "This is not a valid regular expression, so the rule does nothing.",
        "too big": "This regular expression is too big, so the rule does nothing.",
        "look-around": "A rule can't use look-around, so this one does nothing.",
        "back-reference": "A rule can't use back-references, so this one does nothing.",
      }[problem] ?? "A rule can't use all of this expression, so it does nothing.";
    },
  };
})();
