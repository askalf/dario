/**
 * Pure helpers used by scripts/auto-draft-drift-fix.mjs. Lives in its
 * own module so the tests can import the functions without triggering
 * the main script's top-level "read argv → patch files → emit JSON"
 * side-effect chain.
 */

/**
 * Compare two dotted-numeric version strings. Returns true iff `a` is
 * strictly older than `b` (semver-ish, no pre-release handling — the
 * CC versions we compare look like `2.1.118`, no `-rc` suffix so far).
 */
export function isOlderThan(a, b) {
  const pa = a.split('.').map((x) => parseInt(x, 10));
  const pb = b.split('.').map((x) => parseInt(x, 10));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x < y) return true;
    if (x > y) return false;
  }
  return false;
}

/**
 * Patch the `maxTested` property inside a TypeScript source string.
 * Matches `maxTested: 'X.Y.Z'` or `maxTested: "X.Y.Z"` (either quote
 * style) and replaces with the new version. Returns:
 *
 *   { patched: string | null, before: string | null, after: string }
 *
 * `patched === null` when:
 *   - No `maxTested` property exists in the source (surrounding shape drifted)
 *   - The current value is NOT older than the requested new value
 *     (guard against moving backward or redundant writes)
 */
export function patchMaxTested(source, _oldVersionFromReport, newVersion) {
  const re = /(\bmaxTested\s*:\s*['"])([^'"]+)(['"])/;
  const m = re.exec(source);
  if (!m) return { patched: null, before: null, after: newVersion };
  const before = m[2];
  if (!isOlderThan(before, newVersion)) {
    return { patched: null, before, after: newVersion };
  }
  const patched = source.replace(re, `$1${newVersion}$3`);
  return { patched, before, after: newVersion };
}

/**
 * Insert a bullet line immediately after the `## [Unreleased]` HEADING
 * in a CHANGELOG string. Line-anchored regex avoids matching the
 * string occurrence inside the top-of-file HTML comment that
 * describes the convention.
 *
 * Returns the changelog unchanged if no Unreleased heading exists —
 * the bot isn't aggressive enough to reshape the file.
 */
export function appendUnreleased(changelog, bullet) {
  const re = /^## \[Unreleased\]\s*$/m;
  const m = re.exec(changelog);
  if (!m || typeof m.index !== 'number') return changelog;
  const afterHeading = changelog.indexOf('\n', m.index + m[0].length);
  if (afterHeading === -1) return changelog;
  const tail = changelog.slice(afterHeading + 1);
  const insertion = `\n${bullet}\n`;
  return changelog.slice(0, afterHeading + 1) + insertion + tail;
}
