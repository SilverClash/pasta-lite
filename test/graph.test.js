'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { layout, createLayout, COLOR_COUNT } = require('../renderer/graph.js');

// ---------- helpers ----------

// Build commits from a compact spec: [['c', 'b a'], ['b', 'a'], ['a', '']]
function C(spec) {
  return spec.map(([hash, parents]) => ({ hash, parents: parents ? parents.split(' ') : [] }));
}

const key = (l) => `${l.from[0]}:${l.from[1]}>${l.to[0]}:${l.to[1]}`;
const lineKeys = (row) => row.lines.map(key).sort();
const topCols = (row) => [...new Set(row.lines.filter((l) => l.from[1] === 'top').map((l) => l.from[0]))].sort((a, b) => a - b);
const bottomCols = (row) => [...new Set(row.lines.filter((l) => l.to[1] === 'bottom').map((l) => l.to[0]))].sort((a, b) => a - b);
const byHash = (res) => Object.fromEntries(res.rows.map((r) => [r.hash, r]));

function checkInvariants(commits, res, label = '') {
  assert.equal(res.rows.length, commits.length, label);
  // continuity: distinct columns leaving the bottom of row i == entering top of row i+1
  // (a merge edge that joins an existing pass-through lane shares that column, hence sets)
  if (res.rows.length) assert.deepEqual(topCols(res.rows[0]), [], `${label} first row has no top lines`);
  for (let i = 0; i + 1 < res.rows.length; i++) {
    assert.deepEqual(bottomCols(res.rows[i]), topCols(res.rows[i + 1]), `${label} continuity at row ${i}`);
  }
  let maxCol = -1;
  const present = new Set(commits.map((c) => c.hash));
  res.rows.forEach((r, i) => {
    const c = commits[i];
    assert.equal(r.hash, c.hash);
    assert.equal(r.isMerge, c.parents.length > 1);
    assert.equal(r.colorIndex, r.column % 10);
    maxCol = Math.max(maxCol, r.column);
    for (const l of r.lines) {
      maxCol = Math.max(maxCol, l.from[0], l.to[0]);
      assert.ok(l.colorIndex >= 0 && l.colorIndex < 10);
      if (l.from[1] === 'mid' || l.to[1] === 'mid') {
        // anything touching mid must touch the node column
        const midCol = l.from[1] === 'mid' ? l.from[0] : l.to[0];
        assert.equal(midCol, r.column, `${label} mid line off-node at row ${i}`);
      }
    }
    // one start edge per distinct parent
    const starts = r.lines.filter((l) => l.from[1] === 'mid');
    assert.equal(starts.length, new Set(c.parents).size, `${label} start edges row ${i}`);
    // no two pass-throughs in the same column
    const pass = r.lines.filter((l) => l.from[1] === 'top' && l.to[1] === 'bottom').map((l) => l.from[0]);
    assert.equal(new Set(pass).size, pass.length);
  });
  assert.equal(res.width, maxCol + 1, `${label} width`);
  // lanes still open after the last row must all await parents missing from the list
  if (res.rows.length) {
    const openCount = bottomCols(res.rows[res.rows.length - 1]).length;
    const missing = new Set();
    let missingEdges = 0;
    commits.forEach((c) => new Set(c.parents).forEach((p) => { if (!present.has(p)) { missing.add(p); missingEdges++; } }));
    assert.ok(openCount >= missing.size && openCount <= missingEdges, `${label} open lanes at bottom`);
  }
}

// Seeded PRNG (mulberry32)
function rng(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Random DAG: commits created oldest-first; output reversed (children before parents).
function randomDag(seed, size) {
  const r = rng(seed);
  const made = [];
  for (let i = 0; i < size; i++) {
    const parents = [];
    if (i > 0 && r() > 0.05) {
      const np = r() < 0.2 ? 2 + (r() < 0.2 ? 1 : 0) : 1;
      for (let k = 0; k < np; k++) {
        // bias toward recent commits
        const back = Math.min(i, 1 + Math.floor(r() * r() * Math.min(i, 30)));
        const p = made[i - back].hash;
        if (!parents.includes(p)) parents.push(p);
      }
    }
    made.push({ hash: `r${seed}_${i}`, parents });
  }
  const list = made.reverse();
  // sometimes cut off the tail (history paging) so parents go missing
  return r() < 0.3 ? list.slice(0, Math.max(1, Math.floor(list.length * 0.6))) : list;
}

// ---------- fixtures ----------

const FIXTURES = {
  linear: C([['d', 'c'], ['c', 'b'], ['b', 'a'], ['a', '']]),
  branchMerge: C([['m', 'b f'], ['f', 'a'], ['b', 'a'], ['a', '']]),
  twoBranches: C([['x', 'p'], ['y', 'p'], ['p', 'o'], ['o', ''], ]),
  twoBranchesReuse: C([['x', 'p'], ['y', 'p'], ['z', 'p'], ['p', 'o'], ['q', 'o'], ['o', '']]),
  octopus: C([['m', 'a b c d'], ['a', 'r'], ['b', 'r'], ['c', 'r'], ['d', 'r'], ['r', '']]),
  multiRoot: C([['m', 'a z'], ['a', 'b'], ['z', 'y'], ['b', ''], ['y', '']]),
  crissCross: C([['m1', 'a2 b2'], ['m2', 'b2 a2'], ['a2', 'a1 b1'], ['b2', 'b1 a1'], ['a1', 'r'], ['b1', 'r'], ['r', '']]),
  missingParent: C([['c', 'b'], ['b', 'gone'], ['s', 'gone2']]),
  twoLanes: C([['m', 'a t'], ['t', 'q'], ['a', 'q'], ['q', '']]),
};

// ---------- tests ----------

test('empty input', () => {
  assert.deepEqual(layout([]), { width: 0, rows: [] });
  assert.deepEqual(layout(undefined), { width: 0, rows: [] });
});

test('single commit', () => {
  const res = layout(C([['a', '']]));
  assert.equal(res.width, 1);
  assert.deepEqual(res.rows, [{ hash: 'a', column: 0, colorIndex: 0, isMerge: false, lines: [] }]);
});

test('linear history stays in column 0 with correct lines', () => {
  const commits = FIXTURES.linear;
  const res = layout(commits);
  assert.equal(res.width, 1);
  assert.ok(res.rows.every((r) => r.column === 0 && r.colorIndex === 0 && !r.isMerge));
  assert.deepEqual(lineKeys(res.rows[0]), ['0:mid>0:bottom']);
  assert.deepEqual(lineKeys(res.rows[1]), ['0:mid>0:bottom', '0:top>0:mid']);
  assert.deepEqual(lineKeys(res.rows[2]), ['0:mid>0:bottom', '0:top>0:mid']);
  assert.deepEqual(lineKeys(res.rows[3]), ['0:top>0:mid']);
  checkInvariants(commits, res);
});

test('simple branch + merge', () => {
  const commits = FIXTURES.branchMerge;
  const res = layout(commits);
  const r = byHash(res);
  assert.equal(r.m.isMerge, true);
  assert.equal(r.m.column, 0);
  assert.deepEqual(lineKeys(r.m), ['0:mid>0:bottom', '0:mid>1:bottom']);
  assert.equal(r.f.column, 1);
  assert.equal(r.f.colorIndex, 1);
  assert.deepEqual(lineKeys(r.f), ['0:top>0:bottom', '1:mid>1:bottom', '1:top>1:mid']);
  assert.equal(r.b.column, 0);
  assert.deepEqual(lineKeys(r.b), ['0:mid>0:bottom', '0:top>0:mid', '1:top>1:bottom']);
  // lanes converge at the fork point
  assert.equal(r.a.column, 0);
  assert.deepEqual(lineKeys(r.a), ['0:top>0:mid', '1:top>0:mid']);
  const conv = r.a.lines.find((l) => l.from[0] === 1);
  assert.equal(conv.colorIndex, 1, 'converging curve keeps the side lane colour');
  assert.equal(res.width, 2);
  checkInvariants(commits, res);
});

test('two branches from the same parent converge; freed column is reused', () => {
  const res = layout(FIXTURES.twoBranches);
  const r = byHash(res);
  assert.equal(r.x.column, 0);
  assert.equal(r.y.column, 1);
  assert.equal(r.p.column, 0);
  assert.deepEqual(lineKeys(r.p), ['0:mid>0:bottom', '0:top>0:mid', '1:top>0:mid']);
  assert.deepEqual(lineKeys(r.o), ['0:top>0:mid']);
  checkInvariants(FIXTURES.twoBranches, res);

  const commits = FIXTURES.twoBranchesReuse;
  const res2 = layout(commits);
  const r2 = byHash(res2);
  assert.deepEqual([r2.x.column, r2.y.column, r2.z.column, r2.p.column], [0, 1, 2, 0]);
  assert.deepEqual(lineKeys(r2.p), ['0:mid>0:bottom', '0:top>0:mid', '1:top>0:mid', '2:top>0:mid']);
  // columns 1 and 2 were freed at p; q gets the lowest free one (1)
  assert.equal(r2.q.column, 1);
  assert.deepEqual(lineKeys(r2.o), ['0:top>0:mid', '1:top>0:mid']);
  assert.equal(res2.width, 3);
  checkInvariants(commits, res2);
});

test('octopus merge (4 parents)', () => {
  const commits = FIXTURES.octopus;
  const res = layout(commits);
  const r = byHash(res);
  assert.equal(r.m.isMerge, true);
  assert.deepEqual(lineKeys(r.m), ['0:mid>0:bottom', '0:mid>1:bottom', '0:mid>2:bottom', '0:mid>3:bottom']);
  assert.deepEqual([r.a.column, r.b.column, r.c.column, r.d.column], [0, 1, 2, 3]);
  assert.equal(r.r.column, 0);
  assert.equal(r.r.lines.filter((l) => l.to[1] === 'mid').length, 4);
  assert.equal(res.width, 4);
  checkInvariants(commits, res);
});

test('multiple roots (unrelated histories)', () => {
  const commits = FIXTURES.multiRoot;
  const res = layout(commits);
  const r = byHash(res);
  assert.equal(r.z.column, 1);
  assert.equal(r.y.column, 1);
  assert.deepEqual(lineKeys(r.b), ['0:top>0:mid', '1:top>1:bottom']);
  assert.deepEqual(lineKeys(r.y), ['1:top>1:mid']);
  // independent root without children starts in the lowest free column
  const res2 = layout(C([['a', ''], ['b', '']]));
  assert.deepEqual(res2.rows.map((x) => x.column), [0, 0]);
  assert.deepEqual(res2.rows.map((x) => x.lines), [[], []]);
  checkInvariants(commits, res);
});

test('criss-cross merges', () => {
  const commits = FIXTURES.crissCross;
  const res = layout(commits);
  const r = byHash(res);
  assert.equal(r.m1.column, 0);
  // m1 reserved a2@0 and b2@1, so the unrelated tip m2 opens column 2
  assert.equal(r.m2.column, 2);
  // b2 is awaited by lane 1 (m1 merge) and lane 2 (m2 first parent): lowest wins
  assert.equal(r.b2.column, 1);
  assert.equal(r.a2.column, 0);
  assert.ok(r.a2.isMerge && r.b2.isMerge);
  assert.equal(r.r.column, 0);
  checkInvariants(commits, res);
});

test('parent missing from list: lane runs to the bottom of the last row', () => {
  const commits = FIXTURES.missingParent;
  const res = layout(commits);
  const r = byHash(res);
  assert.equal(r.b.column, 0);
  assert.deepEqual(lineKeys(r.b), ['0:mid>0:bottom', '0:top>0:mid']);
  // s is an unrelated tip; lane 0 (awaiting 'gone') passes through
  assert.equal(r.s.column, 1);
  assert.deepEqual(lineKeys(r.s), ['0:top>0:bottom', '1:mid>1:bottom']);
  assert.deepEqual(bottomCols(res.rows[res.rows.length - 1]), [0, 1]);
  checkInvariants(commits, res);
});

test('commit reached by two lanes takes the lowest column', () => {
  // m (col 0) merges t (col 1); t and a both lead to q
  const commits = FIXTURES.twoLanes;
  const res = layout(commits);
  const r = byHash(res);
  assert.equal(r.t.column, 1);
  assert.equal(r.a.column, 0);
  assert.equal(r.q.column, 0);
  assert.deepEqual(lineKeys(r.q), ['0:top>0:mid', '1:top>0:mid']);
  // reverse: lower lane is the second child
  const res2 = layout(C([['t', 'q'], ['u', 'x'], ['x', 'q'], ['q', '']]));
  const r2 = byHash(res2);
  assert.equal(r2.t.column, 0);
  assert.equal(r2.u.column, 1);
  assert.equal(r2.q.column, 0);
  assert.deepEqual(lineKeys(r2.q), ['0:top>0:mid', '1:top>0:mid']);
  checkInvariants(commits, res);
});

test('merge edge joins an already-reserved lane instead of opening a new one', () => {
  // y (col1) awaits p; m merges p too -> edge into lane 1
  const commits = C([['y', 'p'], ['m', 'a p'], ['a', 'p'], ['p', '']]);
  const res = layout(commits);
  const r = byHash(res);
  assert.equal(r.y.column, 0);
  assert.equal(r.m.column, 1);
  assert.deepEqual(lineKeys(r.m), ['0:top>0:bottom', '1:mid>0:bottom', '1:mid>1:bottom']);
  assert.equal(res.width, 2);
  checkInvariants(commits, res);
});

test('lanes never shift sideways: a lane keeps its column and colour until it ends', () => {
  for (let s = 1; s <= 10; s++) {
    const commits = randomDag(s, 120);
    const res = layout(commits);
    res.rows.forEach((row) => {
      for (const l of row.lines) {
        if (l.from[1] === 'top' && l.to[1] === 'bottom') {
          assert.equal(l.from[0], l.to[0]);
          assert.equal(l.colorIndex, l.from[0] % 10);
        }
      }
    });
  }
});

test('pinned: first-parent chain of the pinned commit stays in column 0', () => {
  // main tip is newer than the pinned branch but pinned keeps column 0
  const commits = C([
    ['m2', 'm1'], ['f2', 'f1'], ['m1', 'b'], ['f1', 'b'], ['b', 'a'], ['a', ''],
  ]);
  const plain = byHash(layout(commits));
  assert.equal(plain.m2.column, 0);
  assert.equal(plain.f2.column, 1);
  const res = layout(commits, { pinned: 'f2' });
  const r = byHash(res);
  assert.equal(r.f2.column, 0);
  assert.equal(r.f1.column, 0);
  assert.equal(r.b.column, 0);
  assert.equal(r.a.column, 0);
  assert.equal(r.m2.column, 1);
  assert.deepEqual(lineKeys(r.m2), ['1:mid>1:bottom'], 'blocked column 0 is not drawn');
  assert.deepEqual(lineKeys(r.b), ['0:mid>0:bottom', '0:top>0:mid', '1:top>0:mid']);
  checkInvariants(commits, res, 'pinned');
  // unknown pinned sha is ignored
  assert.deepEqual(layout(commits, { pinned: 'nope' }), layout(commits));
});

test('continuity + width invariants across all fixtures', () => {
  for (const [name, commits] of Object.entries(FIXTURES)) checkInvariants(commits, layout(commits), name);
});

test('continuity invariant on 50 random DAGs (seeded)', () => {
  for (let s = 1; s <= 50; s++) {
    const commits = randomDag(s * 7919, 20 + (s * 13) % 180);
    checkInvariants(commits, layout(commits), `seed ${s}`);
    // pinning an arbitrary commit must keep invariants and hold column 0
    const pin = commits[Math.floor(commits.length / 3)].hash;
    const res = layout(commits, { pinned: pin });
    checkInvariants(commits, res, `seed ${s} pinned`);
    const byH = new Map(commits.map((c) => [c.hash, c]));
    const colOf = new Map(res.rows.map((x) => [x.hash, x.column]));
    for (let cur = pin; cur && byH.has(cur); cur = byH.get(cur).parents[0]) {
      assert.equal(colOf.get(cur), 0, `seed ${s}: first-parent chain commit ${cur} must be in column 0`);
    }
  }
});

test('createLayout: a layout resumed page by page equals the full layout', () => {
  const pages = (list, sizes) => {
    const out = [];
    let i = 0;
    for (let k = 0; i < list.length; k++) {
      const n = sizes[k % sizes.length];
      out.push(list.slice(i, i + n));
      i += n;
    }
    return out;
  };
  for (let s = 1; s <= 30; s++) {
    const commits = randomDag(s * 104729, 30 + (s * 17) % 170);
    const pin = commits[Math.min(commits.length - 1, s % 5)].hash; // in the first page
    for (const opts of [{}, { pinned: pin }]) {
      const full = layout(commits, opts);
      const lay = createLayout(opts);
      let res;
      for (const page of pages(commits, [7, 1, 23, 50])) {
        assert.ok(lay.canResume, `seed ${s}: resumable`);
        res = lay.add(page);
      }
      assert.equal(lay.count, commits.length);
      assert.deepEqual(res, full, `seed ${s} ${opts.pinned ? 'pinned' : 'plain'}`);
    }
  }
});

test('createLayout: a pinned commit not in the first page makes the layout non-resumable', () => {
  const commits = C([['c', 'b'], ['b', 'a'], ['a', '']]);
  const lay = createLayout({ pinned: 'a' });
  lay.add(commits.slice(0, 2));
  assert.equal(lay.canResume, false, 'a full layout would have blocked column 0 from row 0');
  const plain = createLayout({});
  plain.add(commits.slice(0, 2));
  assert.equal(plain.canResume, true);
  const each = plain.add([]);
  assert.notEqual(each.rows, plain.add([]).rows, 'a new rows array per call');
  assert.equal(COLOR_COUNT, 10);
});

// Synthetic repo: several long-lived branches, frequent forks and merges.
function syntheticHistory(size, seed) {
  const r = rng(seed);
  const made = [];
  let heads = ['h0'];
  made.push({ hash: 'h0', parents: [] });
  let n = 1;
  while (made.length < size) {
    const roll = r();
    const bi = Math.floor(r() * heads.length);
    const hash = `h${n++}`;
    if (roll < 0.1 && heads.length < 40) {
      // fork: new branch from an existing head
      made.push({ hash, parents: [heads[bi]] });
      heads.push(hash);
    } else if (roll < 0.18 && heads.length > 1) {
      // merge another branch into this one and delete it
      let oi = Math.floor(r() * heads.length);
      if (oi === bi) oi = (oi + 1) % heads.length;
      made.push({ hash, parents: [heads[bi], heads[oi]] });
      heads[bi] = hash;
      heads.splice(oi, 1);
    } else {
      made.push({ hash, parents: [heads[bi]] });
      heads[bi] = hash;
    }
  }
  return made.reverse();
}

test('performance: 20,000 commits with frequent branches/merges', () => {
  const commits = syntheticHistory(20000, 42);
  layout(commits); // warm-up
  const t0 = process.hrtime.bigint();
  const res = layout(commits);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(`# layout(20000) took ${ms.toFixed(1)} ms, width ${res.width}`);
  assert.equal(res.rows.length, 20000);
  assert.ok(ms < 500, `took ${ms} ms`);
  checkInvariants(commits, res, 'perf');
});
