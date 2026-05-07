/**
 * Small helper: run a shell command, capture stdout/stderr,
 * emit a structured result. Not an abstraction layer — just a
 * one-line fix for the ergonomics of `child_process.spawn` when
 * you want: "exit code, stdout, stderr, done".
 *
 * Intentionally does NOT inherit stdio. The deploy scripts emit a
 * single-line JSON report to stdout at the end, so they must not
 * interleave child-process chatter.
 */

import { spawn } from 'node:child_process'

export interface RunResult {
  exitCode: number
  stdout: string
  stderr: string
  durationMs: number
}

export interface RunOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
  /** Stop collecting output after this many bytes per stream. */
  maxOutputBytes?: number
}

export async function run(
  cmd: string,
  args: string[],
  opts: RunOptions = {},
): Promise<RunResult> {
  const t0 = Date.now()
  return await new Promise<RunResult>((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const outChunks: Buffer[] = []
    const errChunks: Buffer[] = []
    const cap = opts.maxOutputBytes ?? 256 * 1024
    let outBytes = 0
    let errBytes = 0

    child.stdout.on('data', (d: Buffer) => {
      outBytes += d.length
      if (outBytes <= cap) outChunks.push(d)
    })
    child.stderr.on('data', (d: Buffer) => {
      errBytes += d.length
      if (errBytes <= cap) errChunks.push(d)
    })

    const timer = opts.timeoutMs
      ? setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs)
      : null

    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      resolve({
        exitCode: code ?? -1,
        stdout: Buffer.concat(outChunks).toString('utf-8'),
        stderr: Buffer.concat(errChunks).toString('utf-8'),
        durationMs: Date.now() - t0,
      })
    })
    child.on('error', (err) => {
      if (timer) clearTimeout(timer)
      resolve({
        exitCode: -1,
        stdout: '',
        stderr: (err as Error).message,
        durationMs: Date.now() - t0,
      })
    })
  })
}

/**
 * Emit a single-line JSON report to stdout. Callers should only call
 * this once at the end of the script — the agent's deploy.run tool
 * parses the LAST non-empty line as the structured result.
 */
export function emitReport(report: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(report) + '\n')
}
