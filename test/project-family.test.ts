import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import {
  gitRootOf,
  familyOf,
  collapseSessionCwds,
  resetProjectFamilyCache,
} from '../src/project-family.js';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'pf-'));
}

test('gitRootOf finds a real .git directory from a cwd 3 levels deep', () => {
  resetProjectFamilyCache();
  const root = join(tmp(), 'kevq', 'process');
  mkdirSync(join(root, '.git'), { recursive: true });
  const deep = join(root, 'backend', 'db', 'migrations');
  mkdirSync(deep, { recursive: true });
  assert.equal(gitRootOf(deep), root);
  assert.equal(familyOf(deep), 'process');
});

test('worktree .git FILE with absolute gitdir resolves to the main repo root', () => {
  resetProjectFamilyCache();
  const base = tmp();
  const main = join(base, 'quaestor');
  mkdirSync(join(main, '.git', 'worktrees', 'wt1'), { recursive: true });
  const wt = join(base, 'quaestor-cl-iter-02');
  mkdirSync(wt, { recursive: true });
  writeFileSync(join(wt, '.git'), `gitdir: ${join(main, '.git', 'worktrees', 'wt1')}\n`);
  assert.equal(gitRootOf(wt), main);
  assert.equal(familyOf(join(wt, 'src')), 'quaestor');
});

test('worktree .git FILE with relative gitdir resolves against the file dir', () => {
  resetProjectFamilyCache();
  const base = tmp();
  const main = join(base, 'main');
  mkdirSync(join(main, '.git', 'worktrees', 'wt1'), { recursive: true });
  const wt = join(base, 'wt1');
  mkdirSync(wt, { recursive: true });
  writeFileSync(join(wt, '.git'), `gitdir: ${['..', 'main', '.git', 'worktrees', 'wt1'].join(sep)}\n`);
  assert.equal(gitRootOf(wt), main);
});

test('submodule .git FILE (gitdir under /.git/modules/) is its own project', () => {
  resetProjectFamilyCache();
  const base = tmp();
  const superRoot = join(base, 'super');
  mkdirSync(join(superRoot, '.git', 'modules', 'lib'), { recursive: true });
  const sub = join(superRoot, 'vendor', 'lib');
  mkdirSync(sub, { recursive: true });
  writeFileSync(join(sub, '.git'), `gitdir: ${join(superRoot, '.git', 'modules', 'lib')}\n`);
  assert.equal(gitRootOf(sub), sub);
  assert.equal(familyOf(sub), 'lib');
});

test('garbage .git file falls back to its containing dir', () => {
  resetProjectFamilyCache();
  const dir = join(tmp(), 'odd');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '.git'), 'not a gitdir pointer');
  assert.equal(gitRootOf(dir), dir);
});

test('dead path resolves to undefined (fails closed)', () => {
  resetProjectFamilyCache();
  assert.equal(gitRootOf(join(tmp(), 'gone', 'sub', 'dir')), undefined);
  assert.equal(familyOf('/definitely/not/a/real/path/anywhere'), undefined);
});

test('memoized within a run: answer survives the fixture being deleted', () => {
  resetProjectFamilyCache();
  const root = join(tmp(), 'repo');
  mkdirSync(join(root, '.git'), { recursive: true });
  assert.equal(gitRootOf(root), root);
  rmSync(root, { recursive: true, force: true });
  assert.equal(gitRootOf(root), root); // memo, no disk re-read
  resetProjectFamilyCache();
  assert.equal(gitRootOf(root), undefined); // fresh run sees current disk
});

test('collapseSessionCwds adopts the shallowest observed ancestor, zero disk', () => {
  const m = collapseSessionCwds([
    '/w/kevq/process',
    '/w/kevq/process/backend',
    '/w/kevq/process/frontend',
    '/w/kevq/process/backend/db',
    '/tmp/scratch',
  ]);
  assert.equal(m.get('/w/kevq/process'), 'process');
  assert.equal(m.get('/w/kevq/process/backend'), 'process');
  assert.equal(m.get('/w/kevq/process/frontend'), 'process');
  assert.equal(m.get('/w/kevq/process/backend/db'), 'process');
  assert.equal(m.get('/tmp/scratch'), 'scratch');
});

test('collapseSessionCwds never merges sibling repos under an unvisited parent', () => {
  const m = collapseSessionCwds(['/home/dev/repo-a', '/home/dev/repo-b']);
  assert.equal(m.get('/home/dev/repo-a'), 'repo-a');
  assert.equal(m.get('/home/dev/repo-b'), 'repo-b');
});

test('collapseSessionCwds normalizes mixed separators', () => {
  const m = collapseSessionCwds(['C:\\w\\proj', 'C:\\w\\proj\\sub', 'C:/w/proj/sub/deep']);
  assert.equal(m.get('C:\\w\\proj\\sub'), 'proj');
  assert.equal(m.get('C:/w/proj/sub/deep'), 'proj');
});
