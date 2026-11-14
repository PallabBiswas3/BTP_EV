import type { RunStreamEvent } from './types'

const MAX_LINE_CHARS = 48 * 1024 * 1024
const MAX_ARTIFACT_BYTES = 32 * 1024 * 1024
const ownedUrls = new WeakMap<object, string[]>()

export function releaseResultArtifacts(result: unknown): void {
  if (typeof result !== 'object' || result === null) return
  for (const url of ownedUrls.get(result) ?? []) URL.revokeObjectURL(url)
  ownedUrls.delete(result)
}

/** Consume one request's progress and terminal result, without a follow-up GET. */
export async function readRunStream<T>(
  response: Response, onProgress?: (phase: string, step: number, nSteps: number) => void,
): Promise<T> {
  if (!response.body) throw new Error('The server returned an empty simulation response.')
  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let buffer = ''
  let finished = false
  let result: T | undefined
  let artifactBytes = 0
  const urls: string[] = []
  const artifacts = new Map<string, { name: string; url: string }>()

  const consume = (line: string) => {
    if (!line.trim()) return
    if (line.length > MAX_LINE_CHARS) throw new Error('The simulation response exceeded the download limit.')
    if (finished) throw new Error('Unexpected data after the simulation finished.')
    const event = JSON.parse(line) as RunStreamEvent<T>
    if (!event || typeof event !== 'object') throw new Error('Invalid simulation response.')
    switch (event.type) {
      case 'heartbeat': return
      case 'progress':
        if (typeof event.phase !== 'string' || !Number.isFinite(event.step) || !Number.isFinite(event.n_steps)) {
          throw new Error('Invalid simulation progress response.')
        }
        onProgress?.(event.phase, event.step, event.n_steps)
        return
      case 'artifact': {
        if (event.mime_type !== 'image/png' || typeof event.name !== 'string' ||
            typeof event.url !== 'string' || !event.url.startsWith('inline:') ||
            typeof event.data_base64 !== 'string' || artifacts.has(event.url)) {
          throw new Error('Invalid plot download response.')
        }
        // Check the encoded length before allocating decoded bytes.
        if (event.data_base64.length > Math.ceil((MAX_ARTIFACT_BYTES - artifactBytes) / 3) * 4) {
          throw new Error('Plots exceeded the browser download limit.')
        }
        const binary = atob(event.data_base64)
        artifactBytes += binary.length
        if (artifactBytes > MAX_ARTIFACT_BYTES || !binary.startsWith('\x89PNG\r\n\x1a\n')) {
          throw new Error('Invalid or oversized PNG download.')
        }
        const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
        const url = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }))
        urls.push(url)
        artifacts.set(event.url, { name: event.name, url })
        return
      }
      case 'error': throw new Error(typeof event.message === 'string' ? event.message : 'Simulation failed.')
      case 'result':
        if (event.result === null || typeof event.result !== 'object') throw new Error('Invalid simulation result.')
        result = event.result
        finished = true
        return
      default: throw new Error('Unknown simulation response event.')
    }
  }

  try {
    while (true) {
      const { value, done } = await reader.read()
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true })
      let newline: number
      while ((newline = buffer.indexOf('\n')) !== -1) {
        consume(buffer.slice(0, newline))
        buffer = buffer.slice(newline + 1)
      }
      if (buffer.length > MAX_LINE_CHARS) throw new Error('The simulation response exceeded the download limit.')
      if (done) break
    }
    if (buffer.trim()) consume(buffer)
    if (!finished || result === undefined) {
      throw new Error('The connection ended before the simulation finished. The run was not completed.')
    }
    const withArtifacts = result as { artifacts?: { name: string; url: string }[] }
    if (Array.isArray(withArtifacts.artifacts)) {
      withArtifacts.artifacts = withArtifacts.artifacts.map((item) => {
        const artifact = artifacts.get(item.url)
        if (!artifact) throw new Error('A simulation plot was missing from the response.')
        return artifact
      })
    } else if (artifacts.size) {
      throw new Error('The simulation returned plots without a download manifest.')
    }
    ownedUrls.set(result as object, urls)
    return result
  } catch (error) {
    for (const url of urls) URL.revokeObjectURL(url)
    throw error
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}
