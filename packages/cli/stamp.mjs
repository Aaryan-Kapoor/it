// Writes a release's tag into the copy of an install script that the release carries.
//
// In the repository each script names no release, and installs whichever is latest. The copy
// published with a release names that release, so that everything it downloads (the checksums,
// the program, the terms and the notices) comes from the release the script itself came from,
// even when a newer release is published before or while it runs. `release.mjs` stamps the
// copies it puts beside the programs, and the install test stamps copies of its own with this.

/** The line in each script that names its release, as it is in the repository, and as it is once stamped. */
const UNSTAMPED = {
  'install.sh': ['\nRELEASE=""\n', (tag) => `\nRELEASE="${tag}"\n`],
  'install.ps1': ["\n  $release = ''\n", (tag) => `\n  $release = '${tag}'\n`],
}

/**
 * The script `name` (`install.sh` or `install.ps1`), whose text is `text`, with the release
 * `tag` written into it. It throws where the tag is not one a release has, or where the script
 * does not hold the unstamped line exactly once, so that no release is built with a script that
 * would go on to install whichever release is latest.
 */
export function stamp(name, text, tag) {
  const line = UNSTAMPED[name]
  if (!line) throw new Error(`${name} is not an install script that names its release`)
  if (!/^v\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(tag)) throw new Error(`${tag} is not the tag of a release`)
  const [unstamped, stamped] = line
  const at = text.indexOf(unstamped)
  if (at < 0 || text.indexOf(unstamped, at + 1) >= 0) throw new Error(`${name} does not hold the line that names its release exactly once`)
  return text.slice(0, at) + stamped(tag) + text.slice(at + unstamped.length)
}
