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
 * Insert a bullet line immediately after a CHANGELOG heading. Line-
 * anchored regex avoids matching string occurrences inside HTML
 * comments. Default: matches `## [Unreleased]`. Can target a specific
 * version heading via the `heading` parameter (used by the auto-
 * release flow, where the heading has just been promoted to
 * `## [X.Y.Z] - date`).
 *
 * Returns the changelog unchanged if the target heading doesn't
 * exist — the bot isn't aggressive enough to reshape the file.
 */
export function appendUnreleased(changelog, bullet, heading = /^## \[Unreleased\]\s*$/m) {
  const re = typeof heading === 'string' ? new RegExp(`^${escapeRe(heading)}\\s*$`, 'm') : heading;
  const m = re.exec(changelog);
  if (!m || typeof m.index !== 'number') return changelog;
  // Use the heading's START position (m.index) rather than match
  // length — the regex may greedily consume trailing `\n`s via `\s*`,
  // which would make `afterHeading` skip past the heading line.
  const lineEnd = changelog.indexOf('\n', m.index);
  if (lineEnd === -1) return changelog;
  const tail = changelog.slice(lineEnd + 1);
  const insertion = `\n${bullet}\n`;
  return changelog.slice(0, lineEnd + 1) + insertion + tail;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Bump a dotted-numeric version's LAST component by 1. Pure, returns
 * a new string. Rejects versions with non-numeric segments. Used by
 * the auto-drafter to move `3.31.11` → `3.31.12` when producing a
 * release-ready PR.
 */
export function bumpPatch(version) {
  const parts = version.split('.');
  if (parts.length < 2) throw new Error(`version must have at least two segments: ${version}`);
  for (const p of parts) {
    if (!/^\d+$/.test(p)) throw new Error(`non-numeric segment in version: ${version}`);
  }
  const last = parts.length - 1;
  parts[last] = String(parseInt(parts[last], 10) + 1);
  return parts.join('.');
}

/**
 * Parse a package.json string, bump its `version` field's patch
 * component, return the updated JSON string. Preserves the original
 * object shape and two-space indentation (dario's package.json
 * convention). Throws if `version` isn't present or isn't parseable.
 */
export function bumpPackageJsonPatch(pkgJsonString) {
  const pkg = JSON.parse(pkgJsonString);
  if (typeof pkg.version !== 'string') {
    throw new Error('package.json has no version field');
  }
  const newVersion = bumpPatch(pkg.version);
  pkg.version = newVersion;
  // Preserve trailing newline — dario's package.json has one.
  return {
    content: JSON.stringify(pkg, null, 2) + '\n',
    before: JSON.parse(pkgJsonString).version,
    after: newVersion,
  };
}

/**
 * Promote the current `## [Unreleased]` section to a dated version
 * heading and insert a fresh `## [Unreleased]` above it. Mirrors the
 * CHANGELOG convention documented in the top-of-file HTML comment
 * (introduced in v3.31.10): at release time, rename Unreleased to
 * `## [X.Y.Z] - YYYY-MM-DD` and open a new Unreleased above.
 *
 * If the changelog has no `## [Unreleased]` heading, returns unchanged.
 */
export function promoteUnreleased(changelog, newVersion, date) {
  const re = /^## \[Unreleased\]\s*$/m;
  const m = re.exec(changelog);
  if (!m || typeof m.index !== 'number') return changelog;
  const before = changelog.slice(0, m.index);
  const after = changelog.slice(m.index + m[0].length);
  const dated = `## [Unreleased]\n\n## [${newVersion}] - ${date}`;
  return before + dated + after;
}
