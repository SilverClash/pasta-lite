'use strict';
// electron-builder afterAllArtifactBuild hook (package.json "build.afterAllArtifactBuild"),
// build-time only. electron-builder 26 notarizes and staples the .app but not the DMG around it,
// so for a release build this submits each Developer ID-signed DMG to Apple's notary service
// with the notarytool keychain profile named in APPLE_KEYCHAIN_PROFILE, waits for the verdict
// and staples the ticket. Unsigned builds (npm run dist:mac:unsigned) are left alone.
const { execFileSync, spawnSync } = require('node:child_process');

/** True when codesign reports a Developer ID Application signature on `file`. */
function developerIdSigned(file) {
  const r = spawnSync('codesign', ['-dv', '--verbose=2', file], { encoding: 'utf8' });
  return /Authority=Developer ID Application:/.test(`${r.stdout || ''}${r.stderr || ''}`);
}

module.exports = async function notarizeDmgs(result) {
  const dmgs = (result.artifactPaths || []).filter((p) => p.endsWith('.dmg') && developerIdSigned(p));
  if (!dmgs.length) return [];
  const mac = (result.configuration && result.configuration.mac) || {};
  if (mac.notarize === false) {
    console.log('  • skipped DMG notarization  reason=mac.notarize is false');
    return [];
  }
  const profile = process.env.APPLE_KEYCHAIN_PROFILE;
  if (!profile) throw new Error('APPLE_KEYCHAIN_PROFILE is not set, so the signed DMGs cannot be notarized (use npm run dist:mac)');
  const keychain = process.env.APPLE_KEYCHAIN ? ['--keychain', process.env.APPLE_KEYCHAIN] : [];
  for (const dmg of dmgs) {
    console.log(`  • notarizing DMG  file=${dmg}`);
    const out = execFileSync('xcrun', ['notarytool', 'submit', dmg, '--keychain-profile', profile, ...keychain,
      '--wait', '--output-format', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
    const { id, status } = JSON.parse(out);
    if (status !== 'Accepted') {
      throw new Error(`Notarization of ${dmg} ended with status ${status}. See: xcrun notarytool log ${id} --keychain-profile ${profile}`);
    }
    execFileSync('xcrun', ['stapler', 'staple', dmg], { stdio: 'inherit' });
  }
  return [];
};
