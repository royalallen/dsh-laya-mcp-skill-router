/**
 * Small persistence and hashing helpers shared by the index, the optimizer
 * and the eval script.
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * Stable short content hash.
 * @param parts - values joined into the hashed text.
 * @returns 16 hex characters.
 */
export function hashOf(...parts) {
  return createHash('sha256').update(parts.map((part) => String(part ?? '')).join('\u0000')).digest('hex').slice(0, 16)
}

/**
 * Read a JSON file, returning a fallback when it is missing or unreadable.
 * @param path - file path.
 * @param fallback - value returned on any read or parse failure.
 * @returns the parsed value or the fallback.
 */
export async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return fallback
  }
}

/**
 * Write JSON through a temp file and rename, so a crash cannot leave half a file.
 * @param path - destination.
 * @param value - JSON-serializable value.
 */
export async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temp, JSON.stringify(value), 'utf8')
  await rename(temp, path)
}

/**
 * Trailing-edge debounce that also exposes a way to flush immediately.
 * @param fn - async or sync function to run.
 * @param ms - quiet period in milliseconds.
 * @returns a callable with `cancel()` and `flush()`.
 */
export function debounce(fn, ms) {
  let timer
  const run = () => {
    timer = undefined
    return fn()
  }
  const trigger = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(run, ms)
    timer.unref?.()
  }
  trigger.cancel = () => {
    if (timer) clearTimeout(timer)
    timer = undefined
  }
  trigger.flush = () => {
    if (!timer) return undefined
    clearTimeout(timer)
    return run()
  }
  return trigger
}

/**
 * Rough token estimate used only for logging the saving.
 * @param value - string or JSON value.
 * @returns characters / 4, rounded up.
 */
export function estimateTokens(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '')
  return Math.ceil(text.length / 4)
}

/**
 * Race a promise against a timeout and an optional caller signal.
 * @param promise - work to wait for.
 * @param ms - timeout in milliseconds.
 * @param signal - optional abort signal.
 * @returns the promise's value.
 * @throws a `TimeoutError` or the signal's reason.
 */
export function withTimeout(promise, ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const error = new Error(`timed out after ${ms} ms`)
      error.name = 'TimeoutError'
      reject(error)
    }, ms)
    timer.unref?.()
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason ?? new Error('aborted'))
    }
    if (signal) {
      if (signal.aborted) return onAbort()
      signal.addEventListener('abort', onAbort, { once: true })
    }
    promise.then(
      (value) => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

/**
 * Glob match supporting `*` only, which is all tool-name patterns need.
 * @param pattern - pattern such as `mcp__github__*`.
 * @param name - candidate name.
 * @returns whether it matches.
 */
export function globMatch(pattern, name) {
  if (!pattern.includes('*')) return pattern === name
  const escaped = pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')
  return new RegExp(`^${escaped}$`).test(name)
}
