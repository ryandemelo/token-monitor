import test from 'node:test';
import assert from 'node:assert/strict';
import { collapseSessionCwds, sessionProjectOf } from '../src/project-family.js';

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

test('collapseSessionCwds never merges sibling projects under an unvisited parent', () => {
  const m = collapseSessionCwds(['/home/dev/repo-a', '/home/dev/repo-b']);
  assert.equal(m.get('/home/dev/repo-a'), 'repo-a');
  assert.equal(m.get('/home/dev/repo-b'), 'repo-b');
});

test('collapseSessionCwds normalizes mixed separators', () => {
  const m = collapseSessionCwds(['C:\\w\\proj', 'C:\\w\\proj\\sub', 'C:/w/proj/sub/deep']);
  assert.equal(m.get('C:\\w\\proj\\sub'), 'proj');
  assert.equal(m.get('C:/w/proj/sub/deep'), 'proj');
});

test('adoption works even when the ancestor is observed AFTER the descendant', () => {
  // Sessions can start in a subdir and cd up later; the label must not
  // depend on observation order.
  const m = collapseSessionCwds(['/w/dev/repo/backend', '/w/dev/repo']);
  assert.equal(m.get('/w/dev/repo/backend'), 'repo');
});

test('near-root launch dirs never donate their name to descendants', () => {
  // Session launched in the home dir, then worked in a repo: the repo keeps
  // its own name instead of everything becoming "ryan".
  const m = collapseSessionCwds(['/Users/ryan', '/Users/ryan/Documents/GitHub/jobmachine']);
  assert.equal(m.get('/Users/ryan/Documents/GitHub/jobmachine'), 'jobmachine');
  assert.equal(m.get('/Users/ryan'), 'ryan');
  // …but a real project dir (≥3 segments) still donates
  const m2 = collapseSessionCwds(['/Users/ryan/dev/repo', '/Users/ryan/dev/repo/sub']);
  assert.equal(m2.get('/Users/ryan/dev/repo/sub'), 'repo');
});

test('sessionProjectOf picks the dominant per-event label, ties to first-seen', () => {
  assert.equal(sessionProjectOf(['/w/kevq/process', '/w/kevq/process/backend']), 'process');
  assert.equal(sessionProjectOf(['/w/kevq/process/backend', '/w/kevq/process']), 'process');
  assert.equal(sessionProjectOf(['/gone/dev/proj-alpha']), 'proj-alpha'); // single-cwd unchanged
  assert.equal(sessionProjectOf([]), undefined);
  // launched at home, worked in the repo → the repo wins on event count
  assert.equal(
    sessionProjectOf(['/Users/ryan', '/Users/ryan/dev/app', '/Users/ryan/dev/app']),
    'app',
  );
  // a brief scratch detour does not rename the session
  assert.equal(sessionProjectOf(['/w/deep/repo', '/w/deep/repo', '/tmp/scratch']), 'repo');
  // dead-even tie goes to the first-seen label
  assert.equal(sessionProjectOf(['/w/deep/repo-a', '/w/deep/repo-b']), 'repo-a');
});
