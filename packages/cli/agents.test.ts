// Project agents as this machine keeps them (`it agents`): nothing is offered until someone at
// the machine turns them on, only the folders named here are offered, the site is told a word
// for each folder and never its path beyond the home folder, and a note that cannot be read
// offers nothing.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AGENTS } from '@it/protocol'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { changeAgents, folderOf, offerOf, readAgents, shownAs } from './src/agents'

let dir: string
let file: string
beforeEach(() => {
  dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'it-agents-')))
  file = path.join(dir, 'agents.json')
  mkdirSync(path.join(dir, 'garden'))
  mkdirSync(path.join(dir, 'shed'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('project agents on this machine', () => {
  test('are off, and offer nothing, until they are turned on here', () => {
    expect(readAgents(file)).toEqual({ on: false, most: AGENTS.most, projects: [] })
    expect(offerOf(readAgents(file))).toBeNull()
    changeAgents({ add: path.join(dir, 'garden') }, file)
    // A folder named while they are off is kept, and offered only once they are on
    expect(offerOf(readAgents(file))).toBeNull()
    changeAgents({ to: 'on', most: 2 }, file)
    const offer = offerOf(readAgents(file), dir)
    expect(offer).toEqual({ most: 2, projects: [{ id: expect.stringMatching(/^[A-Za-z0-9_-]{12}$/), name: 'garden', where: `~${path.sep}garden` }] })
    changeAgents({ to: 'off' }, file)
    expect(offerOf(readAgents(file))).toBeNull()
  })

  test('offer a folder by a word of their own, which is all an agent can be started by', () => {
    changeAgents({ to: 'on' }, file)
    const { added } = changeAgents({ add: path.join(dir, 'garden') }, file)
    // Named twice, it is the one folder, with the one word
    expect(changeAgents({ add: `${path.join(dir, 'garden')}${path.sep}` }, file).added).toEqual(added)
    expect(folderOf(readAgents(file), added!.id)).toBe(path.join(dir, 'garden'))
    // A word that is not one of them, or a path, names nothing
    expect(folderOf(readAgents(file), path.join(dir, 'shed'))).toBeNull()
    expect(folderOf(readAgents(file), 'no-such-word')).toBeNull()
    // Nor once it is turned off, nor once the folder is gone
    changeAgents({ to: 'off' }, file)
    expect(folderOf(readAgents(file), added!.id)).toBeNull()
    changeAgents({ to: 'on' }, file)
    rmSync(path.join(dir, 'garden'), { recursive: true })
    expect(folderOf(readAgents(file), added!.id)).toBeNull()
  })

  test('take only a folder that is there, and not the whole disk or home folder', () => {
    expect(() => changeAgents({ add: path.join(dir, 'nowhere') }, file)).toThrow(/no folder/)
    writeFileSync(path.join(dir, 'a-file'), '')
    expect(() => changeAgents({ add: path.join(dir, 'a-file') }, file)).toThrow(/no folder/)
    expect(() => changeAgents({ add: os.homedir() }, file)).toThrow(/project’s own folder/)
    expect(() => changeAgents({ add: path.parse(dir).root }, file)).toThrow(/project’s own folder/)
    expect(() => changeAgents({ remove: path.join(dir, 'shed') }, file)).toThrow(/not a folder that It offers/)
    expect(() => changeAgents({ most: AGENTS.mostAllowed + 1 }, file)).toThrow(/--most/)
    expect(() => changeAgents({ most: 0 }, file)).toThrow(/--most/)
  })

  test('let a folder go when it is removed', () => {
    changeAgents({ to: 'on' }, file)
    changeAgents({ add: path.join(dir, 'garden') }, file)
    changeAgents({ add: path.join(dir, 'shed') }, file)
    expect(changeAgents({ remove: path.join(dir, 'garden') }, file).removed?.path).toBe(path.join(dir, 'garden'))
    expect(readAgents(file)).toMatchObject({ projects: [{ path: path.join(dir, 'shed') }] })
  })

  test('offer nothing where their note cannot be read, and change nothing in it', () => {
    for (const broken of ['{not json', '[]', '{"on":"yes","projects":[]}', '{"on":true,"projects":[{"id":"../x","path":"/tmp"}]}']) {
      writeFileSync(file, broken)
      expect(readAgents(file)).toBe('unread')
      expect(offerOf(readAgents(file))).toBeNull()
      expect(() => changeAgents({ to: 'on' }, file)).toThrow(/could not read/)
    }
  })

  test('show a folder under the home folder from there, and any other where it is', () => {
    expect(shownAs('/home/sam/code/garden', '/home/sam')).toEqual({ name: 'garden', where: `~${path.sep}code${path.sep}garden` })
    expect(shownAs('/srv/garden', '/home/sam')).toEqual({ name: 'garden', where: '/srv/garden' })
  })
})
