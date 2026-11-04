/**
 * The README's local testing steps: the proxy key never sits on a command line,
 * and the prompt that writes `.dev.vars` writes what wrangler reads.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const README = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'README.md'), 'utf8')
const SHELL_BLOCKS = [...README.matchAll(/^```(?:sh|bash|shell|console)\n([\s\S]*?)^```$/gm)].map((match) => match[1]!)
const SHELLS = ['bash', 'zsh'].filter((shell) => spawnSync(shell, ['-c', 'true']).status === 0)

describe('README', () => {
  it('never puts the proxy key on a command line', () => {
    const inline = [...README.replace(/^```[\s\S]*?^```$/gm, '').matchAll(/`([^`\n]+)`/g)].map((match) => match[1]!)
    for (const line of [...SHELL_BLOCKS.flatMap((block) => block.split('\n')), ...inline]) {
      expect(line).not.toMatch(/fly_px_/)
      expect(line).not.toMatch(/FINGERLY_PROXY_KEY=(?!%s)\S/)
    }
  })

  it('writes .dev.vars from the prompt, readable only by its owner', () => {
    const blocks = SHELL_BLOCKS.filter((block) => block.includes('> .dev.vars'))
    expect(blocks).toHaveLength(1)
    // The prompt is the last command of its block, so nothing pasted after it is read as the key.
    expect(blocks[0]!.trimEnd().split('\n').at(-1)).toMatch(/> \.dev\.vars; unset proxy_key$/)
    const key = 'fly_px_development_k3yFromThePrompt'
    expect(SHELLS.length).toBeGreaterThan(0)
    for (const shell of SHELLS) {
      const dir = mkdtempSync(join(tmpdir(), 'dev-vars-'))
      try {
        writeFileSync(join(dir, 'wrangler.toml.example'), '')
        writeFileSync(join(dir, '.dev.vars'), 'stale\n', { mode: 0o644 })
        const run = spawnSync(shell, ['-c', blocks[0]!], { cwd: dir, input: `${key}\n`, encoding: 'utf8' })
        expect(run.status, `${shell}: ${run.stderr}`).toBe(0)
        expect(run.stdout, shell).not.toContain(key)
        expect(readFileSync(join(dir, '.dev.vars'), 'utf8'), shell).toBe(`FINGERLY_PROXY_KEY=${key}\nFINGERLY_DEV_UPSTREAM=http://localhost:8080\n`)
        expect(statSync(join(dir, '.dev.vars')).mode & 0o777, shell).toBe(0o600)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }
  })
})
