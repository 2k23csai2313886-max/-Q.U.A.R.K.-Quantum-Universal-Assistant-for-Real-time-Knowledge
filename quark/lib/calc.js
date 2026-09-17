/**
 * Q.U.A.R.K. — safe expression evaluator
 * ─────────────────────────────────────────────────────────────────────────
 * Hand-written tokenizer + recursive-descent parser. NO eval, NO Function,
 * NO dynamic code of any kind. The original project got this right; this is
 * that idea extended to powers, modulo, unary minus, ~40 math functions and
 * named constants.
 *
 * Grammar
 *   expr    := term (('+' | '-') term)*
 *   term    := unary (('*' | '/' | '%') unary)*
 *   unary   := ('-' | '+') unary | power
 *   power   := primary ('^' unary)?          // right-assoc, so 2^3^2 = 512
 *   primary := NUMBER | CONST | FUNC '(' args ')' | '(' expr ')'
 */

const CONSTANTS = {
  pi: Math.PI,
  e: Math.E,
  tau: Math.PI * 2,
  phi: (1 + Math.sqrt(5)) / 2,
  inf: Infinity,
};

const FUNCTIONS = {
  sqrt: Math.sqrt, cbrt: Math.cbrt, abs: Math.abs, sign: Math.sign,
  sin: Math.sin, cos: Math.cos, tan: Math.tan,
  asin: Math.asin, acos: Math.acos, atan: Math.atan, atan2: Math.atan2,
  sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh,
  log: Math.log10, log10: Math.log10, log2: Math.log2, ln: Math.log, exp: Math.exp,
  min: Math.min, max: Math.max, pow: Math.pow, hypot: Math.hypot,
  round: Math.round, floor: Math.floor, ceil: Math.ceil, trunc: Math.trunc,
  fact: (n) => {
    if (!Number.isInteger(n) || n < 0) return NaN;
    if (n > 170) return Infinity;
    let r = 1;
    for (let i = 2; i <= n; i++) r *= i;
    return r;
  },
};

const ARITY = { atan2: 2, min: -1, max: -1, pow: 2, hypot: -1, log: 1 };

function tokenize(src) {
  const tokens = [];
  let i = 0;
  const s = String(src).replace(/×/g, '*').replace(/÷/g, '/').replace(/−/g, '-').replace(/\s+/g, ' ').trim();

  while (i < s.length) {
    const c = s[i];
    if (c === ' ') { i++; continue; }

    // number: 12, 12.5, .5, 1e3, 1.2e-3
    const num = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(s.slice(i));
    if (num) { tokens.push({ t: 'num', v: parseFloat(num[0]) }); i += num[0].length; continue; }

    // identifier: constant or function
    const id = /^[a-zA-Z_][a-zA-Z_0-9]*/.exec(s.slice(i));
    if (id) {
      const name = id[0].toLowerCase();
      const rest = s.slice(i + name.length).trimStart();
      const isCall = rest[0] === '(' && name in FUNCTIONS;
      tokens.push({ t: isCall ? 'func' : 'name', v: name });
      i += name.length;
      continue;
    }

    if ('+-*/%^()!,'.includes(c)) { tokens.push({ t: 'op', v: c }); i++; continue; }

    throw new CalcError(`Unexpected character "${c}"`);
  }
  tokens.push({ t: 'end' });
  return tokens;
}

export class CalcError extends Error {}

function parse(src) {
  const tokens = tokenize(src);
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];
  const isOp = (v) => peek().t === 'op' && peek().v === v;

  function primary() {
    const tk = peek();

    if (tk.t === 'num') { next(); return postfix(tk.v); }

    if (tk.t === 'name') {
      next();
      const key = tk.v;
      if (!(key in CONSTANTS)) throw new CalcError(`Unknown name "${key}"`);
      return postfix(CONSTANTS[key]);
    }

    if (tk.t === 'func') {
      next();
      const name = tk.v;
      if (!isOp('(')) throw new CalcError(`Expected "(" after ${name}`);
      next();
      const args = [];
      if (!isOp(')')) {
        args.push(expr());
        while (isOp(',')) { next(); args.push(expr()); }
      }
      if (!isOp(')')) throw new CalcError(`Missing ")" after ${name}(...)`);
      next();
      const want = ARITY[name] ?? 1;
      if (want === -1) { if (args.length < 1) throw new CalcError(`${name} needs at least 1 argument`); }
      else if (args.length !== want) throw new CalcError(`${name} takes ${want} argument(s), got ${args.length}`);
      const fn = FUNCTIONS[name];
      return postfix(fn(...args));
    }

    if (isOp('(')) {
      next();
      const v = expr();
      if (!isOp(')')) throw new CalcError('Missing closing ")"');
      next();
      return postfix(v);
    }

    throw new CalcError(tk.t === 'end' ? 'Unexpected end of expression' : `Unexpected token "${tk.v ?? tk.t}"`);
  }

  /** trailing ! (factorial) and % (percent-of-value) */
  function postfix(v) {
    while (peek().t === 'op' && (peek().v === '!' || peek().v === ',')) {
      if (peek().v === '!') { next(); v = FUNCTIONS.fact(v); }
      else break;
    }
    return v;
  }

  function power() {
    const base = primary();
    if (isOp('^')) { next(); const exp = unary(); return Math.pow(base, exp); } // right-assoc
    return base;
  }

  function unary() {
    if (isOp('-')) { next(); return -unary(); }
    if (isOp('+')) { next(); return unary(); }
    return power();
  }

  function term() {
    let v = unary();
    for (;;) {
      if (isOp('*')) { next(); v *= unary(); }
      else if (isOp('/')) { next(); v /= unary(); }
      else if (isOp('%')) { next(); v %= unary(); }
      else break;
    }
    return v;
  }

  function expr() {
    let v = term();
    for (;;) {
      if (isOp('+')) { next(); v += term(); }
      else if (isOp('-')) { next(); v -= term(); }
      else break;
    }
    return v;
  }

  const result = expr();
  if (peek().t !== 'end') throw new CalcError(`Unexpected "${peek().v}" — expression could not be fully parsed`);
  return result;
}

/**
 * @returns {{ok:true, value:number, display:string} | {ok:false, error:string}}
 */
export function calculate(expression) {
  if (typeof expression !== 'string' || !expression.trim()) {
    return { ok: false, error: 'Empty expression' };
  }
  try {
    const value = parse(expression);
    if (typeof value !== 'number' || Number.isNaN(value)) {
      return { ok: false, error: 'Expression did not resolve to a real number' };
    }
    if (!Number.isFinite(value)) {
      return { ok: true, value, display: value > 0 ? '∞ (overflow)' : '-∞ (overflow)' };
    }
    // Round away binary float noise: 0.1+0.2 -> 0.3
    const rounded = Math.abs(value) < 1e12 ? parseFloat(value.toPrecision(12)) : value;
    return {
      ok: true,
      value: rounded,
      display: formatNumber(rounded),
    };
  } catch (e) {
    return { ok: false, error: e instanceof CalcError ? e.message : 'Could not parse that expression' };
  }
}

export function formatNumber(n) {
  if (Number.isInteger(n) && Math.abs(n) < 1e15) return n.toLocaleString('en-IN');
  if (Math.abs(n) >= 1e15 || (Math.abs(n) < 1e-6 && n !== 0)) return n.toExponential(6);
  return String(parseFloat(n.toPrecision(10)));
}

export const CALC_HELP =
  'Operators: + - * / % ^ ( ) !   ·   Constants: pi, e, tau, phi   ·   ' +
  'Functions: ' + Object.keys(FUNCTIONS).join(', ');
